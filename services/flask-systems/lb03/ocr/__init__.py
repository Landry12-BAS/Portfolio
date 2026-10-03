"""The OCR worker: the one place a visitor's file is decoded, in a process with no network and a cage round it.

The web process never decodes an upload. It checks the size and the first bytes (lb03/sniff.py), stores
the file, and hands the bytes to a subprocess (pool.py) that runs `python -m lb03.ocr.worker`: that process
limits itself (sandbox.py: CPU time, memory, file size, no new privileges, a syscall filter that refuses
the network and every way to start another program, and Landlock where the kernel has it, so the only
folder it can write is its own scratch folder and the only files it can read are the Python it runs),
and only then reads the file (decode.py), reads the words off its pages (engine.py) and writes what it
found into its scratch folder (protocol.py describes it).

Nothing in this package may import the web service, the database, the gateway client or any secret:
the worker's import list is a test (tests/unit/test_lb03_ocr_isolation.py).
"""
