# Printable event QR packs

Roadmap F59 turns the existing single invitation QR into a reusable print pack.
An owner chooses the full event gallery or the curated highlights destination,
a public-facing heading, a short instruction and one, two or four cards per A4
sheet. The default heading is generic rather than copying a private event title.

Generating a pack fetches the current authenticated event gallery and requires
the requested event ID, owner role, retained metadata and an open event. Full
gallery packs additionally require link visibility. Highlight packs fetch the
owner highlight state and require publication. Recheck scope immediately before
offering the generated download. Failures produce no new artifact. This action
does not publish an event, alter access settings or include any passcode.

Build URLs from the current application origin and a validated event UUID.
Accept HTTPS, or loopback HTTP only for a clearly labeled local preview.
Do not accept a user-supplied destination URL, credentials or arbitrary path.
A localhost pack is not a shareable invitation for another device.

The ZIP contains a standalone print.html, a high-resolution PNG, an SVG, a
small destination manifest and printing instructions. The printable document
has one, two or four cards with a QR image, heading, instruction, readable
clickable fallback URL and sign-in guidance. It contains no scripts or external
images, styles or fonts. Text and URL attributes are escaped; the generated
image uses a data URL. A restrictive content-security policy limits document
resources. Fixed archive filenames prevent traversal or filename injection.

Use the existing qrcode generator with a four-module quiet zone and black on
white output. A development-only jsQR decoder verifies generated PNG pixels
against the exact destination. Test full and highlight paths, long origins,
local previews, malicious text escaping, deterministic card counts and archive
contents. Browser acceptance verifies the downloaded pack, freshness checks,
unavailable destinations, moderator denial and recovery.

The print file can be opened locally and printed or saved as PDF through the
browser. PicFind does not claim to have physically scanned a printed card.
Printed codes remain static: event expiry or publication withdrawal denies
future access, and the owner must check access again before distributing a pack.
No production deployment, guest notification or external QR service is added.

Generator documentation: https://github.com/soldair/node-qrcode.
Pixel decoder documentation: https://github.com/cozmo/jsQR (Apache-2.0).
