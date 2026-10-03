"""LB-03 Invoice Reader: supplier invoices and receipts, from photos or PDFs, turned into checked accounting entries.

A visitor's file is stored and read by OCR in a locked-down worker process (no network, a scratch
folder, CPU, memory and time limits), a model fills a typed schema from the words it found, code
checks the arithmetic and may send the document back for one targeted repair, every field is tied to
the words (and so the boxes) it came from, and the validated invoice becomes balanced journal entries
that export as CSV or JSON. See README.md for the pipeline, the limits and the threat model.

This package's `__init__` imports nothing on purpose: the OCR worker (`lb03.ocr`) is started as a
separate process that must not load the web service's code, and importing any module of this package
runs this file first.
"""
