# fable-ultravisor-client

Fable service that talks to an [Ultravisor](https://github.com/stevenvelozo/ultravisor) beacon coordinator over HTTP. Handles authentication, work-item dispatch (synchronous JSON and binary-framed streaming), and operation triggering.

Part of the [retold](https://github.com/stevenvelozo/retold) ecosystem.

## Install

```bash
npm install fable-ultravisor-client
```

## Usage

```javascript
const FableUltravisorClient = require('fable-ultravisor-client');

const client = new FableUltravisorClient(fable, {
    UltravisorURL: 'https://ultravisor.noc.example',
    UserName: 'engineer-alice',
    Password: 'hunter2'
});

client.authenticate((err) => {
    if (err) return console.error(err);

    client.dispatch({
        Capability: 'MeadowProxy',
        Action: 'Request',
        Settings: { Method: 'GET', Path: '/1.0/Books' },
        AffinityKey: 'customer-acme',
        TimeoutMs: 30000
    }, (err, result) => {
        console.log(result.Outputs);
    });
});
```

## Surface

| Method | Description |
|---|---|
| `authenticate(cb)` | POST `/1.0/Authenticate`, captures session cookie. |
| `request(method, path, body, cb, opts)` | Generic JSON HTTP round-trip. `opts.TimeoutMs` bounds the socket. |
| `dispatch(workItem, cb)` | POST `/Beacon/Work/Dispatch` — synchronous JSON result. |
| `dispatchStream(workItem, callbacks, cb)` | POST `/Beacon/Work/DispatchStream` — binary-framed streaming with `onProgress`, `onBinaryData`, `onError` callbacks. Final result includes `OutputBuffer` if binary output streamed. |
| `triggerOperation(hash, parameters, cb)` | POST `/Operation/{hash}/Trigger` — operation entry point. Handles both JSON and `application/octet-stream` responses. |
| `getStatus(cb)` | GET `/Beacon/Capabilities` — returns `{ Capabilities, BeaconCount }`. |
| `configure({ UltravisorURL, UserName, Password })` | Reconfigure at runtime. Clears session cookie. |
| `isConfigured()` | `true` when an UltravisorURL is set. |
| `getSessionCookie()` | Currently captured cookie (diagnostics). |

## Work item shape

```javascript
{
    Capability: 'SomeCapability',    // required
    Action: 'SomeAction',            // required in practice
    Settings: { /* action-specific */ },
    AffinityKey: 'stable-routing-string',  // routes to sticky beacon
    TimeoutMs: 30000                 // ultravisor-side cap
}
```

## Binary frame protocol (dispatchStream)

The `/Beacon/Work/DispatchStream` endpoint returns a chunked response with frames:

```
[1 byte type][4 bytes payload length uint32 BE][payload]
```

| Type | Meaning | Payload |
|---|---|---|
| `0x01` | Progress | JSON `{ Percent, Message, Step, TotalSteps }` |
| `0x02` | Intermediate binary data | Raw bytes |
| `0x03` | Final binary output | Raw bytes (accumulated into `OutputBuffer`) |
| `0x04` | Result metadata | JSON result envelope |
| `0x05` | Error | JSON `{ Error }` (non-fatal notification) |

## License

MIT — see [LICENSE](LICENSE).
