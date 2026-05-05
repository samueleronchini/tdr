Installation
============

Prerequisites
-------------

- Python 3.11
- A working C/C++ build toolchain suitable for scientific Python packages
- Either ``wget`` or ``curl`` available in the system PATH


Create environment
------------------

.. code-block:: bash

   conda create -n TDR python=3.11 pip
   conda activate TDR


Install TDR
-----------

From the repository root:

.. code-block:: bash

   pip install -r requirements.txt
   pip install -e .


Verify installation
-------------------

.. code-block:: bash

   tdr --help


Notes
-----

- The first run can be slow because GWOSC strain files must be downloaded.
- Subsequent runs are faster if data are already present in
  ``<output-dir>/gwosc_cache``.
