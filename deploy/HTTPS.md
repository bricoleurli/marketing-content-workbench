# Anonymous HTTPS trial

Use `nginx-trial.conf` with a dedicated hostname and a Let's Encrypt certificate.
The HTTP challenge directory is `/var/www/marketing-workbench-acme`.
Use certbot's webroot authenticator and an nginx reload deploy hook for renewal.
Run `nginx -t` before every reload. Keep other sites' server blocks unchanged.

The root opens the overlay templates. Private topics, voice history, global API
settings and paid voice generation are not exposed through this entry point.
Uploads and exported files are shared by everyone using the trial. Use only test
materials. This is not a multi-user private workspace; do not attach private
media, API credentials or personal content before adding access controls.

The service remains bound to loopback, with 1.5 CPU cores, 2 GiB memory and one
render at a time. Exports retain 1080p / 30 fps and reuse matching cached files.
GitHub CI and `deploy/release.py` remain the application release path. Nginx and
certificate setup are a separate infrastructure step.
