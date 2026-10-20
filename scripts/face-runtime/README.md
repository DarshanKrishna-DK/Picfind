# Local face runtime evaluation

This standalone development tool verifies pinned YuNet/SFace model files and
runs CPU inference on a blank image and a synthetic 112x112 patch. It never
reads user photos, starts a network server, or changes PicFind's provider.
It requires no API key. It is not an accuracy benchmark or a production service.

Use an isolated Python environment:

```powershell
uv venv artifacts/face-eval-venv --python 3.14
uv pip install --python artifacts/face-eval-venv/Scripts/python.exe -r scripts/face-runtime/requirements.txt
artifacts/face-eval-venv/Scripts/python.exe scripts/face-runtime/evaluate.py --models-dir artifacts/face-models --download
```

The initial download is about 37.1 MiB of model data. Subsequent runs omit
`--download` and work offline. Invalid existing files fail verification and are
never silently replaced. Temporary failed downloads are removed. Review the
printed timings, observed RSS and explicit limitations together.

Defaults: two CPU threads, 640x640 blank detector input, ten timed iterations after
one warmup. Limits: four threads, 1920 input side, 100 iterations. Model loading
and native execution are not enclosed in an operating-system memory sandbox.
This CLI is for trusted local developer use, not untrusted request handling.

The synthetic recognizer patch is already the expected aligned input size.
The tool does not measure real-image decoding, face alignment, event indexing,
false matches, missed matches or production throughput. A passing run only
supports proceeding to a consented real-photo evaluation.

Artifact-only tests require Python but no OpenCV or model downloads:

```powershell
artifacts/face-eval-venv/Scripts/python.exe -m unittest discover -s scripts/face-runtime -p "test_*.py"
```

## Provenance

Models are pinned to OpenCV Zoo commit
`47534e27c9851bb1128ccc0102f1145e27f23f98` and verified against the upstream
Git LFS byte sizes/SHA-256 digests recorded in `evaluate.py`.

- [YuNet README and MIT license](https://github.com/opencv/opencv_zoo/tree/47534e27c9851bb1128ccc0102f1145e27f23f98/models/face_detection_yunet)
- [SFace README and Apache 2.0 license](https://github.com/opencv/opencv_zoo/tree/47534e27c9851bb1128ccc0102f1145e27f23f98/models/face_recognition_sface)
- [Upstream OpenCV inference API](https://docs.opencv.org/4.13.0/d0/dd4/tutorial_dnn_face.html)

Models and environment stay under ignored `artifacts/`. Preserve the upstream
notices when distributing model files. Production use additionally requires
training/data-rights review, consent, scoped persistent indexes, deletion,
calibration and a verified deployment. The existing AWS implementation remains
unchanged until those requirements pass.

## Laptop smoke evidence

2026-10-20, ASUS VivoBook X415JA, i7-1065G7, about 16 GB RAM, Intel Iris Plus.
Python 3.14.0, OpenCV 4.13.0, NumPy 2.4.2, CPU only, two threads, ten iterations:

| Measurement                      | Observed                       |
| -------------------------------- | ------------------------------ |
| Combined verified model bytes    | 38,928,942                     |
| Model initialization             | 272.74 ms                      |
| Median blank 640x640 detection   | 65.05 ms                       |
| Median synthetic patch embedding | 51.74 ms                       |
| Maximum sampled process RSS      | 167,018,496 bytes (159.28 MiB) |

Six artifact safety tests passed. These measurements establish local runtime
compatibility only. They do not establish real event throughput, matching quality,
minimum production RAM or a safe production threshold.
