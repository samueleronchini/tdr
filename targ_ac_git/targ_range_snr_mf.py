import argparse
import json
import logging
import os
import random
import subprocess
import time
from concurrent.futures import ThreadPoolExecutor, as_completed

import h5py
import numpy as np
from astropy.time import Time

try:
    from .aux_snr_mf import compute_antennamap, compute_map, compute_range, map_samples, plot_final, inject, plot_psd
    from .gwosc_utils_snr_mf import GWOSC_SAMPLE_RATE, GWOSCTransientError, GWOSCNoDataError, _get_run_config, _resolve_ifo_config, _load_segment_from_cache
    from .pipeline_utils_snr_mf import _make_psd_from_segment, _validate_psd_file
except ImportError:
    from aux_snr_mf import compute_antennamap, compute_map, compute_range, map_samples, plot_final, inject, plot_psd
    from gwosc_utils_snr_mf import GWOSC_SAMPLE_RATE, GWOSCTransientError, GWOSCNoDataError, _get_run_config, _resolve_ifo_config, _load_segment_from_cache
    from pipeline_utils_snr_mf import _make_psd_from_segment, _validate_psd_file


EOS_LIST = ["SFHo", "DD2"]

CHIRP_MASSES = {
    "bns": [(1, 1), (1.4, 1.4), (2.0, 2.0)],
    "nsbh": [(5, 1), (10, 1.4), (20, 2.0)],
}


def setup_logger(log_file):
    logger = logging.getLogger("targ_range")
    logger.setLevel(logging.INFO)
    logger.handlers.clear()

    handler = logging.FileHandler(log_file, mode="a")
    handler.setFormatter(logging.Formatter("%(asctime)s %(message)s"))
    logger.addHandler(handler)

    return logger


def as_gps_seconds(t0):
    if "T" in str(t0):
        return Time(t0, format="isot", scale="utc").gps
    return float(t0)


def parse_snr_type(value):
    if value == "mf":
        return "matched_filter"
    if value == "opt":
        return "optimal"
    raise ValueError("snr_type must be either 'mf' or 'opt'")


def parse_iota_ranges(iota_min_deg, iota_max_deg):
    if iota_min_deg is None and iota_max_deg is None:
        return [
            {"label": "0-45", "iota_min": 0.0, "iota_max": np.pi / 4},
            {"label": "0-90", "iota_min": 0.0, "iota_max": np.pi / 2},
        ]

    if iota_min_deg is None or iota_max_deg is None:
        raise ValueError("Please provide both --iota-min and --iota-max, or omit both.")

    iota_min = np.radians(float(iota_min_deg))
    iota_max = np.radians(float(iota_max_deg))

    if iota_min < 0:
        raise ValueError("--iota-min must be >= 0 deg")
    if iota_max > np.pi / 2:
        raise ValueError("--iota-max must be <= 90 deg")
    if iota_min >= iota_max:
        raise ValueError("--iota-min must be smaller than --iota-max")

    return [{"label": f"{iota_min_deg:g}-{iota_max_deg:g}", "iota_min": iota_min, "iota_max": iota_max}]


def report_ifos_used(output_dir, ifo_status, strain_segments, online_ifos, logger):
    strain_available_ifos = sorted(strain_segments.keys())
    used_ifos = sorted(online_ifos)

    strain_text = ",".join(strain_available_ifos) if strain_available_ifos else "none"
    used_text = ",".join(used_ifos) if used_ifos else "none"

    message = f"IFOs with available strain data: {strain_text}\nIFOs used in the analysis:      {used_text}"

    print(message, flush=True)
    logger.info(message.replace("\n", " | "))

    with open(os.path.join(output_dir, "ifos_used.txt"), "w") as f:
        f.write(message + "\n")

    with open(os.path.join(output_dir, "ifos_used.json"), "w") as f:
        json.dump({"strain_available_ifos": strain_available_ifos, "used_ifos": used_ifos, "ifo_status": ifo_status}, f, indent=4)


def load_strain_segments(run_cfg, t_center, cache_dir, output_dir, logger):
    strain_segments = {}
    ifo_status = {}
    run_label = os.path.basename(output_dir)

    for ifo in run_cfg["ifos"]:
        ifo_status[ifo] = {"strain_available": False, "psd_ok": False, "usable": False, "network_failed": False, "reason": ""}

    ifos = list(run_cfg["ifos"].keys())
    if not ifos:
        return strain_segments, ifo_status

    try:
        requested_workers = int(os.getenv("TDR_GWOSC_DOWNLOAD_WORKERS", "3"))
    except ValueError:
        requested_workers = 3

    max_workers = min(len(ifos), max(1, requested_workers))
    logger.info(f"{run_label}: loading GWOSC strain with {max_workers} worker(s)")

    def _fetch_ifo(ifo):
        ifo_cfg = _resolve_ifo_config(run_cfg, ifo, t_center)
        seg, used_paths = _load_segment_from_cache(ifo, ifo_cfg, t_center, cache_dir)
        return ifo_cfg, seg, used_paths

    with ThreadPoolExecutor(max_workers=max_workers) as executor:
        futures = {executor.submit(_fetch_ifo, ifo): ifo for ifo in ifos}

        for future in as_completed(futures):
            ifo = futures[future]

            try:
                ifo_cfg, seg, used_paths = future.result()

                strain_segments[ifo] = seg
                ifo_status[ifo]["strain_available"] = True

                logger.info(
                    f"{run_label}: run={run_cfg['name']} ifo={ifo} "
                    f"channel={ifo_cfg['channel']} frame_type={ifo_cfg['frame_type']} "
                    f"sample_rate={ifo_cfg['sample_rate']} strain usable from {used_paths}"
                )

            except GWOSCTransientError as e:
                ifo_status[ifo]["network_failed"] = True
                ifo_status[ifo]["reason"] = f"GWOSC/network failure: {e}"
                logger.info(f"{run_label}: run={run_cfg['name']} ifo={ifo} GWOSC/network failure: {e}")

            except GWOSCNoDataError as e:
                ifo_status[ifo]["reason"] = f"no GWOSC data/incomplete coverage: {e}"
                logger.info(f"{run_label}: run={run_cfg['name']} ifo={ifo} no usable data: {e}")

            except Exception as e:
                ifo_status[ifo]["reason"] = f"strain unavailable/incomplete: {e}"
                logger.info(f"{run_label}: run={run_cfg['name']} ifo={ifo} unavailable: {e}")

    network_failed_ifos = [ifo for ifo, status in ifo_status.items() if status.get("network_failed", False)]
    if network_failed_ifos:
        msg = (
            f"{os.path.basename(output_dir)}: incomplete analysis because GWOSC/network failed for "
            f"IFOs={network_failed_ifos}. Loaded strain for IFOs={list(strain_segments.keys())}. "
            f"Rerun this trigger later; do not treat this as a real detector network."
        )
        with open(os.path.join(output_dir, "analysis_incomplete_network.txt"), "w") as f:
            f.write(msg + "\n")
            f.write(json.dumps(ifo_status, indent=4) + "\n")
        raise GWOSCTransientError(msg)

    if not strain_segments:
        msg = f"{os.path.basename(output_dir)}: no detectors available after successful GWOSC checks"
        with open(os.path.join(output_dir, "no_detectors_available.txt"), "w") as f:
            f.write(msg + "\n")
            f.write(json.dumps(ifo_status, indent=4) + "\n")
        logger.info(msg)

    return strain_segments, ifo_status


def build_psds(strain_segments, t_center, output_dir, ifo_status, logger):
    psd_list, psd_ifos, temp_files = [], [], []

    # Keep PSD objects and IFO labels in the same deterministic order.
    for ifo in sorted(strain_segments.keys()):
        seg = strain_segments[ifo]
        logger.info(f"{os.path.basename(output_dir)}: starting PSD for {ifo}")
        start = time.time()

        try:
            psd_obj, psd_path, temp_hdf5 = _make_psd_from_segment(ifo, seg, t_center, output_dir)
            _validate_psd_file(psd_path, ifo)

            psd_list.append(psd_obj)
            psd_ifos.append(ifo)
            temp_files.append(temp_hdf5)

            ifo_status[ifo]["psd_ok"] = True
            ifo_status[ifo]["usable"] = True
            ifo_status[ifo]["reason"] = "strain complete and PSD valid"

            logger.info(f"{os.path.basename(output_dir)}: finished PSD for {ifo} -> {psd_path} in {time.time() - start:.2f} s")

        except Exception as e:
            ifo_status[ifo]["psd_ok"] = False
            ifo_status[ifo]["usable"] = False
            ifo_status[ifo]["reason"] = f"PSD failed: {e}"
            logger.info(f"{os.path.basename(output_dir)}: PSD failed for {ifo}: {e} in {time.time() - start:.2f} s")

    return psd_list, psd_ifos, temp_files


def run_pycbc_optimal_snr(inj_file, res_file, online_ifos, output_dir):
    cmd = [
        "pycbc_optimal_snr",
        "--snr-columns",
        *[f"{ifo}:optimal_snr_{ifo}" for ifo in online_ifos],
        "--f-low", "30",
        "--seg-length", "256",
        "--sample-rate", "2048",
        "--input-file", inj_file,
        "--output-file", res_file,
    ]

    for ifo in online_ifos:
        cmd.extend(["--psd-file", f"{ifo}:{os.path.join(output_dir, f'{ifo.lower()}_psd.txt')}"])

    subprocess.run(cmd, check=True)


def _read_result_file_ifos(result_file):
    ifos = set()

    with h5py.File(result_file, "r") as f:
        for field in f.keys():
            if "optimal_snr" not in field:
                continue
            ifos.add(field.split("_")[-1])

    return sorted(ifos)


def _result_file_needs_refresh(result_file, online_ifos, logger):
    expected_ifos = sorted(set(online_ifos))

    try:
        result_ifos = _read_result_file_ifos(result_file)
    except Exception as e:
        logger.info(f"Could not read existing result file {result_file}: {e}; will recompute")
        return True

    if result_ifos != expected_ifos:
        logger.info(
            f"Refreshing stale result file {result_file}: file_ifos={result_ifos}, current_ifos={expected_ifos}"
        )
        return True

    return False


def create_injections_and_snr(t_center, online_ifos, output_dir, logger):
    inj_dir = os.path.join(output_dir, "inj")
    res_dir = os.path.join(output_dir, "results")
    os.makedirs(inj_dir, exist_ok=True)
    os.makedirs(res_dir, exist_ok=True)

    ra_max, dec_max = compute_antennamap(online_ifos, t_center)
    logger.info(f"{os.path.basename(output_dir)}: starting injections and pycbc_optimal_snr")

    for cbc_type, masses in CHIRP_MASSES.items():
        for m1, m2 in masses:
            eos_values = EOS_LIST if cbc_type == "nsbh" else [None]

            for eos in eos_values:
                tag = f"_{eos}" if eos is not None else ""

                inject(cbc_type, t_center, [ra_max, dec_max], m1, m2, 0, output_dir, eos=eos if eos is not None else "SFHo")

                inj_file = os.path.join(inj_dir, f"injections_{cbc_type}{tag}_m1_{m1}_m2_{m2}.hdf")
                res_file = os.path.join(res_dir, f"results_{cbc_type}{tag}_m1_{m1}_m2_{m2}.hdf")

                if not os.path.exists(inj_file):
                    raise RuntimeError(f"Expected injection file was not created: {inj_file}")

                if os.path.exists(res_file):
                    if _result_file_needs_refresh(res_file, online_ifos, logger):
                        try:
                            os.remove(res_file)
                        except OSError as e:
                            raise RuntimeError(f"Cannot remove stale result file {res_file}: {e}") from e
                    else:
                        continue

                start = time.time()
                logger.info(f"{os.path.basename(output_dir)}: starting pycbc_optimal_snr for {cbc_type}{tag} m1={m1} m2={m2}")

                run_pycbc_optimal_snr(inj_file, res_file, online_ifos, output_dir)

                logger.info(
                    f"{os.path.basename(output_dir)}: finished pycbc_optimal_snr "
                    f"for {cbc_type}{tag} m1={m1} m2={m2} in {time.time() - start:.2f} s"
                )

    return ra_max, dec_max


def choose_localization_samples(ra, dec, skymap_file, ra_max, dec_max):
    if skymap_file is not None:
        return (*map_samples(skymap_file), skymap_file)

    if ra is not None and dec is not None:
        return [ra], [dec], None

    return [ra_max], [dec_max], None


def run_single_trigger(t_center, output_dir, ra, dec, skymap_file, cache_dir, log_file, iota_ranges, map_iota_min, map_iota_max, snr_threshold, snr_type):
    os.makedirs(output_dir, exist_ok=True)

    logger = setup_logger(log_file)
    start_time = time.time()
    run_cfg = _get_run_config(t_center)

    print(f"[{os.path.basename(output_dir)}] START at t={t_center}", flush=True)

    ra = np.radians(float(ra)) if ra is not None else None
    dec = np.radians(float(dec)) if dec is not None else None

    seed = 12345 + int(round(t_center))
    np.random.seed(seed)
    random.seed(seed)

    strain_segments, ifo_status = load_strain_segments(run_cfg, t_center, cache_dir, output_dir, logger)
    if not strain_segments:
        return

    logger.info(f"{os.path.basename(output_dir)}: building PSDs for {list(strain_segments.keys())}")
    psd_list, online_ifos, temp_files = build_psds(strain_segments, t_center, output_dir, ifo_status, logger)

    report_ifos_used(output_dir, ifo_status, strain_segments, online_ifos, logger)
    logger.info(f"{os.path.basename(output_dir)}: final usable IFOs = {online_ifos}")
    logger.info(f"{os.path.basename(output_dir)}: IFO status = {ifo_status}")

    if not online_ifos:
        logger.info(f"{os.path.basename(output_dir)}: no usable detectors after strain+PSD checks")
        return

    logger.info(f"{os.path.basename(output_dir)}: starting plot_psd")
    plot_psd(psd_list, output_dir, ifos=online_ifos)
    logger.info(f"{os.path.basename(output_dir)}: finished plot_psd")

    ra_max, dec_max = create_injections_and_snr(t_center, online_ifos, output_dir, logger)

    logger.info(f"{os.path.basename(output_dir)}: starting compute_map")
    range_map = compute_map("bns", "1.4", "1.4", online_ifos, output_dir, map_iota_min, map_iota_max, snr_threshold, snr_type)
    logger.info(f"{os.path.basename(output_dir)}: finished compute_map")

    ra_samples, dec_samples, skymap = choose_localization_samples(ra, dec, skymap_file, ra_max, dec_max)

    logger.info(f"{os.path.basename(output_dir)}: starting compute_range")
    compute_range(ra_samples, dec_samples, online_ifos, CHIRP_MASSES, output_dir, iota_ranges, snr_threshold, snr_type)
    logger.info(f"{os.path.basename(output_dir)}: finished compute_range")

    logger.info(f"{os.path.basename(output_dir)}: starting plot_final")
    plot_final(output_dir, range_map, skymap, [ra_samples, dec_samples], map_iota_min, map_iota_max)
    logger.info(f"{os.path.basename(output_dir)}: finished plot_final")
    logger.info(f"{os.path.basename(output_dir)}: completed analysis")

    print(f"[{os.path.basename(output_dir)}] DONE in {time.time() - start_time:.2f} s ({(time.time() - start_time) / 60:.2f} min)", flush=True)

    for tmp in temp_files:
        try:
            os.remove(tmp)
        except OSError:
            pass


def build_parser():
    parser = argparse.ArgumentParser(description="Compute targeted detectability ranges for a single GRB trigger.")

    parser.add_argument("--output-dir", required=True, help="Directory where all outputs will be written.")
    parser.add_argument("--t0", required=True, help="Trigger time as GPS seconds or ISO UTC, e.g. 2020-03-26T12:24:47.903.")

    parser.add_argument("--ra", type=float, default=None, help="Right ascension in degrees.")
    parser.add_argument("--dec", type=float, default=None, help="Declination in degrees.")
    parser.add_argument("--skymap-file", type=str, default=None, help="Optional HEALPix sky map FITS file.")

    parser.add_argument("--iota-min", type=float, default=None, help="Minimum inclination angle in degrees.")
    parser.add_argument("--iota-max", type=float, default=None, help="Maximum inclination angle in degrees.")
    parser.add_argument("--snr-threshold", type=float, default=8.5, help="SNR threshold used to define D90. Default: 8.5.")
    parser.add_argument("--snr-type", choices=["mf", "opt"], default="mf",
        help="SNR type used to define the TDR: 'mf' for matched-filter SNR, 'opt' for optimal SNR. Default: mf.",
    )
    parser.add_argument(
        "--cache-dir",
        default=None,
        help="Optional shared GWOSC cache directory. Default: <output_dir>/gwosc_cache.",
    )

    return parser


def targ_range(args=None):
    parser = build_parser()
    args = parser.parse_args() if args is None else argparse.Namespace(**args) if isinstance(args, dict) else args

    if args.skymap_file == "None":
        args.skymap_file = None

    if args.cache_dir == "None":
        args.cache_dir = None

    if args.skymap_file is None and (args.ra is None or args.dec is None):
        raise ValueError("Please provide either --skymap-file or both --ra and --dec.")

    snr_threshold = float(args.snr_threshold)
    if snr_threshold <= 0:
        raise ValueError("--snr-threshold must be positive")

    snr_type = parse_snr_type(args.snr_type)
    iota_ranges = parse_iota_ranges(args.iota_min, args.iota_max)

    if args.iota_min is None and args.iota_max is None:
        map_iota_min = 0.0
        map_iota_max = np.pi / 4
    else:
        map_iota_min = np.radians(float(args.iota_min))
        map_iota_max = np.radians(float(args.iota_max))

    start_time = time.time()

    os.makedirs(args.output_dir, exist_ok=True)
    log_file = os.path.join(args.output_dir, "targ_range.log")
    open(log_file, "w").close()

    logger = setup_logger(log_file)
    t0 = as_gps_seconds(args.t0)
    event_run_cfg = _get_run_config(t0)

    logger.info(f"Starting targ_range for output_dir={args.output_dir}")
    logger.info(f"Input t0={args.t0}")
    logger.info(f"Input ra={args.ra}, dec={args.dec}")
    logger.info(f"Input skymap_file={args.skymap_file}")
    logger.info(f"Input snr_type={snr_type}")
    logger.info(f"Input snr_threshold={snr_threshold}")
    logger.info(f"Input iota_ranges={iota_ranges}")

    print(f"EVENT RUN = {event_run_cfg['name']}", flush=True)
    print(f"USING GWOSC STRAIN SAMPLE RATE: {GWOSC_SAMPLE_RATE} Hz", flush=True)
    print(f"USING SNR TYPE: {snr_type}", flush=True)
    print(f"USING SNR THRESHOLD: {snr_threshold:g}", flush=True)
    print("USING INCLINATION PRIOR(S):", flush=True)

    for prior in iota_ranges:
        print(f"  {np.degrees(prior['iota_min']):.1f} deg <= iota <= {np.degrees(prior['iota_max']):.1f} deg", flush=True)

    cache_dir = os.path.abspath(args.cache_dir) if args.cache_dir else os.path.join(args.output_dir, "gwosc_cache")
    os.makedirs(cache_dir, exist_ok=True)

    logger.info(f"Using cache_dir={cache_dir}")
    print(f"USING GWOSC CACHE DIR: {cache_dir}", flush=True)

    print("RUNNING SINGLE-TRIGGER ANALYSIS", flush=True)

    try:
        run_single_trigger(t0, args.output_dir, args.ra, args.dec, args.skymap_file, cache_dir, log_file, iota_ranges, map_iota_min, map_iota_max, snr_threshold, snr_type)
    except Exception as e:
        print(f"FAILED: {e}", flush=True)
        with open(os.path.join(args.output_dir, "analysis_failed.txt"), "w") as f:
            f.write(str(e) + "\n")
        raise

    elapsed = time.time() - start_time
    print(f"ANALYSIS COMPLETE in {elapsed:.2f} s ({elapsed / 60:.2f} min)", flush=True)


if __name__ == "__main__":
    targ_range()
