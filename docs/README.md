# Fable Ultravisor Client

An HTTP client for the [Ultravisor](https://stevenvelozo.github.io/ultravisor/) beacon coordinator, packaged as a Fable service. It handles authentication, work-item dispatch (synchronous JSON and binary-framed streaming), and operation triggering, so a host application can hand work to a fleet of remote beacons without re-implementing the wire protocol.

## What It Does

Ultravisor coordinates distributed work. Worker nodes - **beacons** - register with the coordinator and advertise the capabilities they can perform. This client is the *other* side of that arrangement: it authenticates against the coordinator and submits work for those beacons to run.

- **Authentication** - POST credentials to `/1.0/Authenticate` and capture the session cookie for subsequent requests.
- **Synchronous dispatch** - Submit a work item and block on a single JSON result envelope.
- **Streaming dispatch** - Submit a work item and receive progress events, intermediate binary chunks, and a final binary output over a framed `application/octet-stream` response.
- **Operation triggering** - Run a pre-configured Ultravisor operation by hash, receiving either a JSON envelope or a raw binary buffer.
- **Status** - Read the capabilities currently advertised by connected beacons.

## Quick Example

```javascript
const libFableUltravisorClient = require('fable-ultravisor-client');

let _Client = new libFableUltravisorClient(_Fable,
{
	UltravisorURL: 'https://ultravisor.noc.example',
	UserName: 'engineer-alice',
	Password: 'hunter2'
});

_Client.authenticate(
	function (pError)
	{
		if (pError)
		{
			return console.error(pError);
		}

		_Client.dispatch(
			{
				Capability: 'MeadowProxy',
				Action: 'Request',
				Settings: { Method: 'GET', Path: '/1.0/Books' },
				AffinityKey: 'customer-acme',
				TimeoutMs: 30000
			},
			function (pDispatchError, pResult)
			{
				console.log(pResult.Outputs);
			});
	});
```

## The Client and the Beacon

This module is one end of a two-ended protocol:

- **fable-ultravisor-client** (this module) *submits* work to the coordinator.
- **[ultravisor-beacon](https://stevenvelozo.github.io/ultravisor-beacon/)** *registers with* the coordinator and *executes* that work.

The two never talk directly. The Ultravisor coordinator sits between them: it accepts a dispatched work item from this client, routes it to a beacon that advertises the matching `Capability:Action`, collects the result, and streams it back. The work-item shape this client sends (`Capability`, `Action`, `Settings`, `AffinityKey`, `TimeoutMs`) is the same shape the beacon's providers receive.

## Installation

```bash
npm install fable-ultravisor-client
```

## Documentation

- [Quick Start](quickstart.md) - Authenticate and dispatch your first work item
- [API Reference](api.md) - Every method, with verified signatures and the work-item shape
- [Binary Frame Protocol](binary-frame-protocol.md) - The `binary-frames-v1` wire format used by streaming dispatch

## Related Modules

- [fable](https://fable-retold.github.io/fable/) - The service dependency-injection framework this client plugs into
- [ultravisor](https://stevenvelozo.github.io/ultravisor/) - The coordinator/orchestration server this client talks to
- [ultravisor-beacon](https://stevenvelozo.github.io/ultravisor-beacon/) - The worker that executes dispatched work (the other end of the wire)
