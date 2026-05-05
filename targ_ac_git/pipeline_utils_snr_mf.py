import os

import h5py
import numpy as np

try:
    from .gwosc_utils_snr_mf import _write_temp_segment_hdf5
except ImportError:
    from gwosc_utils_snr_mf import _write_temp_segment_hdf5


class PSDWrapper:
    """Minimal wrapper used by the PSD plotting function."""

    def __init__(self, arr):
        self.sample_frequencies = arr[:, 0]
        self.data = arr[:, 1]

    def __array__(self, dtype=None):
        return np.asarray(self.data, dtype=dtype)


def compute_psd_from_hdf5(input_hdf5, t0, output_psd, sample_rate):
    """
    Compute a PSD from a temporary HDF5 strain segment using PyCBC Welch averaging.

    The input file must contain the dataset ``strain/Strain``. The Welch
    configuration uses 16 s segments with 8 s overlap.
    """
    import pycbc
    import pycbc.psd

    with h5py.File(input_hdf5, "r") as f:
        data = f["strain"]["Strain"][:].astype(np.float64)

    ts = pycbc.types.TimeSeries(data, delta_t=1.0 / sample_rate, epoch=t0 - 128)
    ts *= pycbc.DYN_RANGE_FAC

    seg_len = int(16 * sample_rate)
    seg_stride = seg_len // 2

    psd = pycbc.psd.welch(ts, seg_len=seg_len, seg_stride=seg_stride).astype(np.float64)
    psd /= pycbc.DYN_RANGE_FAC**2

    arr = np.column_stack([
        np.asarray(psd.sample_frequencies, dtype=np.float64),
        np.asarray(psd, dtype=np.float64),
    ])

    arr = arr[np.isfinite(arr[:, 0]) & np.isfinite(arr[:, 1])]
    arr = arr[(arr[:, 0] >= 0) & (arr[:, 1] > 0)]

    np.savetxt(output_psd, arr)
    return arr


def _make_psd_from_segment(ifo, segment, t_center, outdir):
    temp_hdf5 = _write_temp_segment_hdf5(segment, ifo, t_center, outdir)
    psd_path = os.path.join(outdir, f"{ifo.lower()}_psd.txt")
    sample_rate = int(round(segment.sample_rate.value))

    arr = compute_psd_from_hdf5(temp_hdf5, t_center, psd_path, sample_rate)
    return PSDWrapper(arr), psd_path, temp_hdf5


def _validate_psd_file(psd_path, ifo):
    arr = np.loadtxt(psd_path)

    if arr.ndim != 2 or arr.shape[1] != 2:
        raise RuntimeError(f"Bad PSD file format for {ifo}: {psd_path}")
    if not np.all(np.isfinite(arr)):
        raise RuntimeError(f"Non-finite values in PSD file for {ifo}: {psd_path}")
    if np.any(arr[:, 0] < 0):
        raise RuntimeError(f"Negative frequencies in PSD file for {ifo}: {psd_path}")
    if np.any(arr[:, 1] <= 0):
        raise RuntimeError(f"Non-positive PSD values in PSD file for {ifo}: {psd_path}")