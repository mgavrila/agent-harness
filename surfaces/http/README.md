# @harness/surface-http

The surface a headless caller speaks as, for the run API (`docs/runbook.md`, "The run API").

It opens no socket and posts nothing. The API's listener is in `@harness/host`; this package
supplies the three things a run driven over HTTP still needs: a `threads.surface` value, a
namespace for the identity plug-in to resolve `(surface, userId)` in, and a loaded session for the
host to find. Every capability is false, and every posting method rejects with a `SurfaceError`,
because an HTTP request has no conversation that outlives it.

Load it **after** a surface a human reads:

    HARNESS_SURFACES=@harness/surface-slack,@harness/surface-http

The first entry is the primary surface and is where approval cards are posted; this one could not
post a card if it were asked to. Give each principal that may call the API an `http` entry in
`clients/<name>/identity.yaml`:

    - id: u-coordinator
      surfaces:
        slack: U0456EFGH
        http: coordinator

The value is any stable string: it is what `POST /v1/runs` sends as `userId`, and the identity
plug-in is the only thing that maps it to a principal.
