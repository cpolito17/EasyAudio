# Security policy

Please report a suspected vulnerability privately through GitHub's **Report a
vulnerability** form for this repository. Do not open a public issue containing
credentials, exploit details, private audio, or personally identifying data.

EasyAudio processes imported audio locally in the browser. The Cloudflare
Worker serves static files and proxies limited, validated requests to
MusicBrainz, the Cover Art Archive, and—when configured—AcoustID. Audio files
are never intentionally uploaded to the Worker.

Security updates target the current default branch. Reports are acknowledged
as soon as practical; please allow time for investigation before disclosure.
