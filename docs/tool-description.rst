Tool description
================

What TDR does
-------------

The ``tdr`` tool computes targeted detectability ranges for one GRB trigger at
a time.

For each run, it:

1. identifies the GW observing run from trigger time ``t0``;
2. checks GWOSC data availability for H1/L1/V1;
3. downloads a 256 s strain segment around the trigger;
4. estimates PSDs for available detectors;
5. generates BNS and NSBH injections with PyCBC;
6. computes SNRs and D90 targeted range values;
7. produces plots, sky maps, and JSON result files.


Main outputs
------------

The output directory typically contains:

- ``targ_range.log``: run log with detector and processing details;
- ``ifos_used.txt`` and ``ifos_used.json``: detector availability and usage;
- ``psd_plot.pdf``: PSD curves used by the analysis;
- ``bns_targeted_range.pdf`` and ``nsbh_targeted_range.pdf``: fraction curves;
- ``results_bns.json`` and ``results_nsbh.json``: final D90 summaries;
- ``range_map_bns_m1_1.4_m2_1.4.fits`` and related PDF map output.


Detector/network behavior
-------------------------

- If GWOSC is temporarily unreachable, the run is marked incomplete and can be
  retried later.
- If a downloaded file is already in cache and valid, it is reused and not
  downloaded again.
