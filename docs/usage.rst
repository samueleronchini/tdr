Use the tool
============

Basic command
-------------

.. code-block:: bash

   tdr --output-dir <output_directory> --t0 <trigger_time> [options]


Required inputs
---------------

- ``--output-dir``: directory where results are written
- ``--t0``: trigger time (GPS seconds or ISO UTC)
- Localization input, one of:

  - ``--ra`` and ``--dec`` in degrees, or
  - ``--skymap-file`` with a HEALPix FITS sky map


Examples
--------

Run with sky position:

.. code-block:: bash

   tdr \
     --output-dir GRB_GIT \
     --t0 2020-03-26T12:24:47.903 \
     --ra 245.33 \
     --dec -21.08 \
   --snr-threshold 9 \
     --snr-type mf

Run with sky map:

.. code-block:: bash

   tdr \
     --output-dir GRB_GIT \
     --t0 2020-03-26T12:24:47.903 \
     --skymap-file examples/glg_healpix_all_bn200326517_v00.fit \
   --snr-threshold 9 \
     --snr-type mf


Command options
---------------

- ``--ra``: right ascension in degrees
- ``--dec``: declination in degrees
- ``--skymap-file``: optional localization sky map FITS file
- ``--iota-min`` and ``--iota-max``: custom inclination prior in degrees
- ``--snr-threshold``: detection threshold used for D90 (default: 9)
- ``--snr-type``: ``mf`` (matched-filter-like) or ``opt`` (optimal)


Output overview
---------------

Typical output tree:

.. code-block:: text

   <output-dir>/
   |-- targ_range.log
   |-- ifos_used.txt
   |-- ifos_used.json
   |-- gwosc_cache/
   |-- inj/
   |-- results/
   |-- psd_plot.pdf
   |-- bns_targeted_range.pdf
   |-- nsbh_targeted_range.pdf
   |-- results_bns.json
   |-- results_nsbh.json
   |-- range_map_bns_m1_1.4_m2_1.4.fits
   `-- range_map_bns_m1_1.4_m2_1.4.pdf
