# Local CPU face extraction

This development worker consumes one operator-authorized JPEG and produces a
private extraction artifact. It is a step toward a local matching provider,
not a production face-search endpoint. It has no listener, API key, cloud call
or implicit model download. The existing application still uses AWS.

The caller supplies event/scan scope, photo UUID, consent-record reference,
photo/reference mode and a new output path. Those labels describe provenance;
they do not verify identity, consent or ownership. Future service integration
must resolve authorization from persisted PicFind records rather than trusting
caller labels. Use only consented evaluation photos or generated fixtures.

The supervisor runs one child process with a deadline and publishes an output
only after successful completion. Input is bounded to 10 MiB, 16 million pixels
and 8,192 pixels per side. JPEG dimensions are checked before native decoding,
OpenCV decode limits are set before import, and decoded dimensions must agree.
Detection runs on a proportional resize with a maximum side of 1,280 by default.
CPU threads are capped at four, faces at 100, and reference mode requires exactly
one detected face. An excessive face count fails rather than silently truncating.
These bounds do not constitute an operating-system memory sandbox.

Verified pinned YuNet/SFace models supply detection, alignment and 128-dimensional
features through the upstream OpenCV API. Features must be finite and nonzero
before L2 normalization. The artifact records model checksums, runtime version,
preprocessing profile, input digest and a pipeline fingerprint. Face IDs derive
from scope, photo, input digest, pipeline and sorted detection position. Repeated
extraction with the same input and pipeline produces stable mappings; changes
to the input or pipeline require a distinct index generation.

Output contains face embeddings and is sensitive. It is written to an exclusive
new file; existing files are never replaced. stdout contains only completion
metadata and counts. Neither reference images nor face crops are saved. Temporary
files are removed on ordinary failures; abrupt termination can leave a private
temporary file. Keep output in a private ignored evaluation folder
and delete it when the evaluation no longer needs it.

Validation combines dependency-free parser/manifest/output tests, stubbed
inference boundary tests and an actual pinned-runtime blank-image smoke run.
No real participant data or face accuracy result is implied. Consented
calibration, scoped persistence/search, retention/erasure, authenticated worker
transport and operational deployment remain separate requirements.
