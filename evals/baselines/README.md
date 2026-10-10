# Baselines

The scores Eval Lab's CI gate holds every pack to, one file per pack (`<pack>.yaml`), each
written by `just gate-lb10 --write-baselines` from a measured run and never by hand. A
baseline names the pack version, the alias, the share of passing cases with its bootstrap
interval, how many cases, when it was measured and how (`live` on the providers, or
`offline` from stored results with a fake gateway, which only the tests write).

No baseline has been measured yet: the owner's provider keys are needed to run the packs
live. Until a pack has one, the gate says so for that pack and compares nothing, instead of
passing or failing on a number nobody measured. The reader is
`services/flask-systems/lb10/baselines.py`.
