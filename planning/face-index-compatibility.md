# Face index compatibility

The local OpenCV evaluation is not a production migration. Before adding another
runtime, PicFind must stop treating a saved result from any provider as reusable.
AWS face identifiers and a local model's embeddings are different index formats.

This safeguard rejects an indexing attempt when an existing photo index belongs
to a different or unidentified provider. It checks before reading image bytes,
reserving processing allowance, contacting the provider or overwriting metadata.
Ready/no-face results also need a stored model version before reuse. Unprocessed
photos remain eligible for the existing AWS path.

Search requires ready photos with matching provider provenance and one declared
model version. It checks before processing the reference or reserving search
allowance, and checks the provider response model before returning any matches.
Photo provenance is refreshed after the provider response; event access is
rechecked before event matches are returned. A rejected response still represents
an already performed provider request and keeps its existing usage accounting.
Stored scan provenance must also agree when present. Missing photo provenance,
mixed models and response mismatches return an explicit compatibility error.
Records remain intact for an explicit repair or reindex migration; no automatic
retry overwrites old face references.

Existing AWS indexes with complete provider/model metadata retain their behavior.
Older incomplete records require investigation and authorized cleanup/reindex.
Do not infer provider identity from an arbitrary face ID or invent a model
version. Readiness marks missing model metadata as requiring attention.

This is a guard at existing processing/search boundaries. It does not add a local
provider, enable new consent, implement generation activation, make provider
deletion interchangeable or claim calibrated accuracy. The remaining migration
work includes a provider-aware cleanup registry, persisted generation manifests,
shadow evaluation, rollback routing and verified erasure.
