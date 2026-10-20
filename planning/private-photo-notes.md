# Private photo instructions

The photo owner can save one private instruction note per photo, such as crop,
retouch or album-placement guidance. Notes are plain text, at most 2,000
characters. An empty saved note clears the content. No guest collaboration,
messages, automatic editing or fulfillment claim is implied.

`GET/PATCH /photos/:id/private-note` require photo ownership. Event moderators
and guests cannot read or change notes. Expired or deleting photos and photos
under a deleting parent event are unavailable. Archiving a gallery does not
remove owner access to notes on otherwise retained photos.

The record stores content, version and update timestamp in the existing Appwrite
JSON payload. Updates require the last-read version and run under the existing
owner account lock. A stale update receives a conflict without overwriting.
This preserves the existing single-process lock contract, not a distributed
database compare-and-swap guarantee. Photo erasure also erases its note.

The owner photo viewer loads notes on demand. Unsaved text is preserved after a
conflict; an explicit load-latest action replaces it. Save before navigating to
another photo. Arrow keys inside the editor edit text instead of changing photos.
Public galleries and moderator views do not mount the editor or expose note
fields through their existing explicit photo projections.
