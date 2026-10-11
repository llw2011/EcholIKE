# EcholIKE systemd service example

`echo-server.service` is an example that starts the backend through a stable
deployment link:

```text
/srv/echolike/current
```

Create the `echolike` service user and group, grant them access to the deployment
directory, and point that link at a complete release directory before starting
the service. Adjust the unit for your own deployment. A release directory must
contain `.env`, `dist/index.js`, `package.json`, and `node_modules`. Keep real
credentials in the deployed `.env`, outside version control.

`echolike-journald.conf` is a host-wide journald retention policy. It caps
persistent journals at 256 MB, rotates files daily, and retains at most 14 days.
The service unit also rate-limits its own journal output.
