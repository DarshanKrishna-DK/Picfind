# Open source face recognition decision

## Decision

Evaluate OpenCV YuNet detection plus SFace recognition on CPU first. Keep the
current AWS provider operational until measured quality, isolation, cleanup and
deployment gates pass. This reopens self-hosted evaluation under the user's
2026-10-20 instruction; it does not silently migrate existing event collections.

| Candidate                                                                          | Assessment                                                                                                                                                         |
| ---------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| [OpenCV YuNet/SFace](https://docs.opencv.org/4.13.0/d0/dd4/tutorial_dnn_face.html) | Small ONNX models and upstream detection/alignment/embedding APIs. Preferred first evaluation.                                                                     |
| [InsightFace](https://github.com/deepinsight/insightface#license)                  | MIT code, but upstream pretrained models/training data are restricted to non-commercial research. Obtain appropriate rights or use independently licensed weights. |
| [DeepFace](https://github.com/serengil/deepface)                                   | Convenient multi-model wrapper. Each underlying weight license and runtime still needs review. Do not enable demographic/emotion analysis.                         |
| [CompreFace](https://github.com/exadel-inc/CompreFace)                             | Self-hosted REST service with deployment overhead. Model license review still applies. Not the lightest laptop-first experiment.                                   |
| [face_recognition/dlib](https://github.com/ageitgey/face_recognition)              | Simple Python API; upstream does not officially support Windows. Not first choice for this Windows environment.                                                    |
| [AuraFace](https://huggingface.co/fal/AuraFace-v1)                                 | Secondary model-card/license review candidate. Larger inference/deployment evaluation required before adoption.                                                    |

YuNet's upstream directory has an MIT license; SFace's directory declares Apache
2.0. Preserve notices and pin model artifacts. These declarations do not replace
review of training provenance, data rights and deployment obligations.
Sources: [YuNet](https://github.com/opencv/opencv_zoo/tree/main/models/face_detection_yunet),
[SFace](https://github.com/opencv/opencv_zoo/tree/main/models/face_recognition_sface).

## Laptop inspection

Live Windows CIM inspection on 2026-10-20:

| Resource               | Observed                                                                                                          |
| ---------------------- | ----------------------------------------------------------------------------------------------------------------- |
| Laptop                 | ASUS VivoBook X415JA                                                                                              |
| CPU                    | Intel Core i7-1065G7, 4 cores, 8 logical processors                                                               |
| Physical RAM           | 16,907,939,840 bytes (15.75 GiB)                                                                                  |
| Free RAM at inspection | 3,426,140 KiB (3.27 GiB), changes with running apps                                                               |
| GPU                    | Intel Iris Plus, reported adapter memory 1 GiB; shared-memory reporting is not a dedicated GPU capacity guarantee |
| C: free                | 19,764,416,512 bytes (18.41 GiB)                                                                                  |
| D: free                | 219,526,451,200 bytes (204.45 GiB)                                                                                |

Hardware is suitable for a small CPU inference experiment. It has no observed
NVIDIA CUDA GPU. Start with one worker, two CPU threads, one image at a time and
bounded input resolution. Close unnecessary applications for larger runs.
Do not infer unattended production capacity from this laptop.

Published Git LFS metadata gives the selected YuNet 2023 model as 232,589 bytes
and SFace float model as 38,696,353 bytes, approximately 37.1 MiB combined.
Python, NumPy, OpenCV, package caches and decoded images add space and RAM.
Reserve roughly 1-2 GiB disk for a small evaluation environment as a planning
allowance, then measure actual usage. Photos usually dominate disk requirements:
10,000 originals averaging 10 MB require about 100 GB before derivatives/backups.
D: has room for a separately approved photo workspace; no files have been moved.

## Keys, hosting and costs

Local OpenCV inference needs no AWS key, subscription or paid API account.
Installation/model download needs internet once; inference can then run offline.
PicFind still needs its Appwrite credentials and product-owned OAuth credentials
for cloud storage/imports. Email/WhatsApp and payments have independent providers.

A deployed private inference service needs a server-to-server credential, TLS or
an appropriately isolated local transport, authorization and network restrictions.
That credential would be ours, not an AWS face-recognition key.
Self-hosting removes per-call Rekognition billing but adds compute, storage,
backup, monitoring and maintenance. A free model is not free production hosting.

## Migration contract

1. Keep `FaceMatchingProvider` as the service boundary. Resolve ownership, access
   and consent before any worker or privileged storage operation.
2. Persist provider/model/detector/alignment version per scope and index generation.
   AWS IDs and SFace vectors are incompatible. Reindex from authorized originals;
   do not copy AWS thresholds into cosine similarity.
3. Use event/scan-scoped private embeddings and stable photo mappings. No global
   identity directory. Do not return embeddings or raw reference photos.
4. Make model downloads explicit, pinned and checksum-verified. No automatic
   unreviewed weights fetched during application startup.
5. Detect and reject zero/multiple-face references. Bound decoded dimensions,
   bytes, faces per photo, queue concurrency and deadlines.
6. Separate feature extraction from scoped index storage/search. Use durable
   jobs, idempotency, retry classification and atomic generation activation.
7. Evaluate threshold on consented, identity-disjoint calibration/test splits:
   false matches, missed matches, group shots, low light, pose, small faces,
   different cameras and representative attendees. Report sample counts and
   uncertainty. Benchmark percentages are not PicFind accuracy claims.
8. Verify consent withdrawal, event/account deletion, backup expiry and restart
   recovery. Encrypt retained matching data; exclude it from logs.
9. Shadow-test without delivering speculative matches. Activate only a verified
   new index generation; retain rollback routing and clean old collections when safe.
10. Update actual provider-specific consent and privacy copy before activation.
    Never silently fall back to AWS after a user selected local-only processing.

A runtime smoke test establishes that the model can load and execute, not that it
recognizes event attendees accurately. Production remains gated on the above.
