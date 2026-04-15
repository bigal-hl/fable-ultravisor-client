/**
 * Unit tests for fable-ultravisor-client
 *
 * Tests run against a local HTTP mock server that simulates the Ultravisor
 * endpoints the client calls: /1.0/Authenticate, /Beacon/Work/Dispatch,
 * /Beacon/Work/DispatchStream, /Beacon/Capabilities, /Operation/{hash}/Trigger.
 *
 * @license MIT
 * @author <steven@velozo.com>
 */

const Chai = require('chai');
const Expect = Chai.expect;
const libHTTP = require('http');

const libFableUltravisorClient = require('../source/Fable-UltravisorClient.js');

// ------------------------------------------------------------------
// Mock Ultravisor server
// ------------------------------------------------------------------
// Each request records what came in so tests can assert on it, and the
// response is controlled by a per-path handler registered by the test.

let _MockServer = null;
let _MockPort = 0;
let _MockHandlers = {};
let _MockRequests = [];

const startMockServer = function (fCallback)
{
	_MockHandlers = {};
	_MockRequests = [];

	_MockServer = libHTTP.createServer((pRequest, pResponse) =>
	{
		let tmpData = '';
		pRequest.on('data', (pChunk) => { tmpData += pChunk; });
		pRequest.on('end', () =>
		{
			let tmpRecord = {
				method: pRequest.method,
				path: pRequest.url,
				headers: pRequest.headers,
				body: tmpData
			};
			_MockRequests.push(tmpRecord);

			let tmpKey = pRequest.method + ' ' + pRequest.url;
			let tmpHandler = _MockHandlers[tmpKey] || _MockHandlers[pRequest.url];
			if (tmpHandler)
			{
				tmpHandler(tmpRecord, pRequest, pResponse);
			}
			else
			{
				pResponse.writeHead(404, { 'Content-Type': 'application/json' });
				pResponse.end(JSON.stringify({ Error: 'no mock handler for ' + tmpKey }));
			}
		});
	});

	_MockServer.listen(0, '127.0.0.1', () =>
	{
		_MockPort = _MockServer.address().port;
		fCallback(null);
	});
};

const stopMockServer = function (fCallback)
{
	if (_MockServer)
	{
		_MockServer.close(fCallback);
		_MockServer = null;
	}
	else
	{
		fCallback(null);
	}
};

const setMockHandler = function (pKey, fHandler)
{
	_MockHandlers[pKey] = fHandler;
};

const mockURL = function ()
{
	return 'http://127.0.0.1:' + _MockPort;
};

// ------------------------------------------------------------------
// Frame encoder (mirrors the ultravisor API server's writeFrame)
// ------------------------------------------------------------------

const encodeFrame = function (pTypeCode, pPayload)
{
	let tmpPayloadBuf = Buffer.isBuffer(pPayload) ? pPayload : Buffer.from(pPayload);
	let tmpHeader = Buffer.alloc(5);
	tmpHeader.writeUInt8(pTypeCode, 0);
	tmpHeader.writeUInt32BE(tmpPayloadBuf.length, 1);
	return Buffer.concat([tmpHeader, tmpPayloadBuf]);
};

// ------------------------------------------------------------------
// Tests
// ------------------------------------------------------------------

suite('Fable-UltravisorClient', () =>
{
	suiteSetup((fDone) => { startMockServer(fDone); });
	suiteTeardown((fDone) => { stopMockServer(fDone); });

	setup(() =>
	{
		_MockHandlers = {};
		_MockRequests = [];
	});

	// --------------------------------------------------------------
	suite('Construction & configuration', () =>
	{
		test('constructs with service type and package metadata', () =>
		{
			let tmpClient = new libFableUltravisorClient();
			Expect(tmpClient.serviceType).to.equal('UltravisorClient');
			Expect(tmpClient._Package).to.be.an('object');
			Expect(tmpClient._Package.name).to.equal('fable-ultravisor-client');
		});

		test('reports not configured when URL is missing', () =>
		{
			let tmpClient = new libFableUltravisorClient();
			Expect(tmpClient.isConfigured()).to.equal(false);
		});

		test('reports configured when URL is provided via options', () =>
		{
			let tmpClient = new libFableUltravisorClient({ UltravisorURL: mockURL() });
			Expect(tmpClient.isConfigured()).to.equal(true);
		});

		test('configure() overwrites settings and clears session cookie', () =>
		{
			let tmpClient = new libFableUltravisorClient({ UltravisorURL: 'http://first' });
			tmpClient._SessionCookie = 'stale=1';
			tmpClient.configure({ UltravisorURL: 'http://second', UserName: 'bob' });
			Expect(tmpClient._UltravisorURL).to.equal('http://second');
			Expect(tmpClient._UserName).to.equal('bob');
			Expect(tmpClient.getSessionCookie()).to.equal(null);
		});

		test('legacy .new() constructor returns an instance', () =>
		{
			let tmpClient = libFableUltravisorClient.new(undefined, { UltravisorURL: mockURL() });
			Expect(tmpClient).to.be.an('object');
			Expect(tmpClient.isConfigured()).to.equal(true);
		});
	});

	// --------------------------------------------------------------
	suite('authenticate()', () =>
	{
		test('captures the session cookie on a 200 response', (fDone) =>
		{
			setMockHandler('POST /1.0/Authenticate', (pRecord, pRequest, pResponse) =>
			{
				pResponse.writeHead(200, {
					'Content-Type': 'application/json',
					'Set-Cookie': 'ultravisor.sid=abc123; Path=/; HttpOnly'
				});
				pResponse.end(JSON.stringify({ Success: true }));
			});

			let tmpClient = new libFableUltravisorClient({
				UltravisorURL: mockURL(),
				UserName: 'alice',
				Password: 'secret'
			});

			tmpClient.authenticate((pError) =>
			{
				Expect(pError).to.equal(null);
				Expect(tmpClient.getSessionCookie()).to.equal('ultravisor.sid=abc123');
				let tmpSentBody = JSON.parse(_MockRequests[0].body);
				Expect(tmpSentBody.UserName).to.equal('alice');
				Expect(tmpSentBody.Password).to.equal('secret');
				fDone();
			});
		});

		test('fails cleanly on 401', (fDone) =>
		{
			setMockHandler('POST /1.0/Authenticate', (pRecord, pRequest, pResponse) =>
			{
				pResponse.writeHead(401, { 'Content-Type': 'application/json' });
				pResponse.end(JSON.stringify({ Error: 'bad creds' }));
			});

			let tmpClient = new libFableUltravisorClient({
				UltravisorURL: mockURL(),
				UserName: 'mallory',
				Password: 'wrong'
			});

			tmpClient.authenticate((pError) =>
			{
				Expect(pError).to.be.an('error');
				Expect(pError.message).to.contain('401');
				Expect(tmpClient.getSessionCookie()).to.equal(null);
				fDone();
			});
		});

		test('errors when URL is not configured', (fDone) =>
		{
			let tmpClient = new libFableUltravisorClient();
			tmpClient.authenticate((pError) =>
			{
				Expect(pError).to.be.an('error');
				Expect(pError.message).to.contain('UltravisorURL');
				fDone();
			});
		});
	});

	// --------------------------------------------------------------
	suite('dispatch() — synchronous JSON work items', () =>
	{
		test('happy path forwards the work item and returns the JSON body', (fDone) =>
		{
			setMockHandler('POST /Beacon/Work/Dispatch', (pRecord, pRequest, pResponse) =>
			{
				pResponse.writeHead(200, { 'Content-Type': 'application/json' });
				pResponse.end(JSON.stringify({
					Success: true,
					Outputs: { Rows: [{ ID: 1 }, { ID: 2 }] }
				}));
			});

			let tmpClient = new libFableUltravisorClient({ UltravisorURL: mockURL() });

			tmpClient.dispatch({
				Capability: 'MeadowProxy',
				Action: 'Request',
				Settings: { Method: 'GET', Path: '/1.0/Books' },
				AffinityKey: 'customer-acme',
				TimeoutMs: 10000
			}, (pError, pResult) =>
			{
				Expect(pError).to.equal(null);
				Expect(pResult).to.be.an('object');
				Expect(pResult.Outputs.Rows).to.have.length(2);

				let tmpSent = JSON.parse(_MockRequests[0].body);
				Expect(tmpSent.Capability).to.equal('MeadowProxy');
				Expect(tmpSent.AffinityKey).to.equal('customer-acme');
				fDone();
			});
		});

		test('attaches session cookie when one is captured', (fDone) =>
		{
			setMockHandler('POST /Beacon/Work/Dispatch', (pRecord, pRequest, pResponse) =>
			{
				pResponse.writeHead(200, { 'Content-Type': 'application/json' });
				pResponse.end(JSON.stringify({ Outputs: {} }));
			});

			let tmpClient = new libFableUltravisorClient({ UltravisorURL: mockURL() });
			tmpClient._SessionCookie = 'ultravisor.sid=test-cookie';

			tmpClient.dispatch({ Capability: 'X', Action: 'Y' }, (pError) =>
			{
				Expect(pError).to.equal(null);
				Expect(_MockRequests[0].headers.cookie).to.equal('ultravisor.sid=test-cookie');
				fDone();
			});
		});

		test('rejects work items without a Capability', (fDone) =>
		{
			let tmpClient = new libFableUltravisorClient({ UltravisorURL: mockURL() });
			tmpClient.dispatch({ Action: 'X' }, (pError) =>
			{
				Expect(pError).to.be.an('error');
				Expect(pError.message).to.contain('Capability');
				fDone();
			});
		});

		test('surfaces a 503 no-beacons error as a callback error', (fDone) =>
		{
			setMockHandler('POST /Beacon/Work/Dispatch', (pRecord, pRequest, pResponse) =>
			{
				pResponse.writeHead(503, { 'Content-Type': 'application/json' });
				pResponse.end(JSON.stringify({ Success: false, Error: 'No Beacon workers are registered.' }));
			});

			let tmpClient = new libFableUltravisorClient({ UltravisorURL: mockURL() });
			tmpClient.dispatch({ Capability: 'X', Action: 'Y' }, (pError, pResult) =>
			{
				Expect(pError).to.be.an('error');
				Expect(pError.message).to.contain('Beacon');
				Expect(pResult).to.equal(undefined);
				fDone();
			});
		});
	});

	// --------------------------------------------------------------
	suite('dispatchStream() — binary-framed streaming', () =>
	{
		test('parses progress, result, and binary-final frames in order', (fDone) =>
		{
			setMockHandler('POST /Beacon/Work/DispatchStream', (pRecord, pRequest, pResponse) =>
			{
				pResponse.writeHead(200, {
					'Content-Type': 'application/octet-stream',
					'Transfer-Encoding': 'chunked'
				});

				// Progress frame (0x01)
				pResponse.write(encodeFrame(0x01, JSON.stringify({ Percent: 25, Message: 'working' })));
				// Intermediate binary frame (0x02)
				pResponse.write(encodeFrame(0x02, Buffer.from([0xDE, 0xAD])));
				// Binary-final frame (0x03)
				pResponse.write(encodeFrame(0x03, Buffer.from([0xBE, 0xEF])));
				// Result frame (0x04)
				pResponse.write(encodeFrame(0x04, JSON.stringify({ Success: true, RunHash: 'r1' })));
				pResponse.end();
			});

			let tmpClient = new libFableUltravisorClient({ UltravisorURL: mockURL() });

			let tmpProgressHits = [];
			let tmpBinaryHits = [];

			tmpClient.dispatchStream(
				{ Capability: 'X', Action: 'Y' },
				{
					onProgress: (pProgress) => { tmpProgressHits.push(pProgress); },
					onBinaryData: (pBuffer) => { tmpBinaryHits.push(pBuffer); }
				},
				(pError, pResult) =>
				{
					Expect(pError).to.equal(null);
					Expect(pResult.Success).to.equal(true);
					Expect(pResult.RunHash).to.equal('r1');
					Expect(Buffer.isBuffer(pResult.OutputBuffer)).to.equal(true);
					Expect(pResult.OutputBuffer.equals(Buffer.from([0xBE, 0xEF]))).to.equal(true);

					Expect(tmpProgressHits).to.have.length(1);
					Expect(tmpProgressHits[0].Percent).to.equal(25);

					Expect(tmpBinaryHits).to.have.length(1);
					Expect(tmpBinaryHits[0].equals(Buffer.from([0xDE, 0xAD]))).to.equal(true);
					fDone();
				});
		});

		test('handles split TCP chunks (frame spans two data events)', (fDone) =>
		{
			setMockHandler('POST /Beacon/Work/DispatchStream', (pRecord, pRequest, pResponse) =>
			{
				pResponse.writeHead(200, { 'Content-Type': 'application/octet-stream' });

				let tmpResultFrame = encodeFrame(0x04, JSON.stringify({ Success: true }));
				// Split in the middle — client must buffer until full payload arrives
				let tmpHalf = Math.floor(tmpResultFrame.length / 2);
				pResponse.write(tmpResultFrame.slice(0, tmpHalf));
				setTimeout(() =>
				{
					pResponse.write(tmpResultFrame.slice(tmpHalf));
					pResponse.end();
				}, 25);
			});

			let tmpClient = new libFableUltravisorClient({ UltravisorURL: mockURL() });

			tmpClient.dispatchStream({ Capability: 'X', Action: 'Y' }, null, (pError, pResult) =>
			{
				Expect(pError).to.equal(null);
				Expect(pResult.Success).to.equal(true);
				fDone();
			});
		});

		test('errors when stream ends without a result frame', (fDone) =>
		{
			setMockHandler('POST /Beacon/Work/DispatchStream', (pRecord, pRequest, pResponse) =>
			{
				pResponse.writeHead(200, { 'Content-Type': 'application/octet-stream' });
				// Only a progress frame, no result frame
				pResponse.write(encodeFrame(0x01, JSON.stringify({ Percent: 50 })));
				pResponse.end();
			});

			let tmpClient = new libFableUltravisorClient({ UltravisorURL: mockURL() });

			tmpClient.dispatchStream({ Capability: 'X', Action: 'Y' }, null, (pError) =>
			{
				Expect(pError).to.be.an('error');
				Expect(pError.message).to.contain('result frame');
				fDone();
			});
		});

		test('surfaces a pre-stream 4xx error', (fDone) =>
		{
			setMockHandler('POST /Beacon/Work/DispatchStream', (pRecord, pRequest, pResponse) =>
			{
				pResponse.writeHead(400, { 'Content-Type': 'application/json' });
				pResponse.end(JSON.stringify({ Error: 'bad capability' }));
			});

			let tmpClient = new libFableUltravisorClient({ UltravisorURL: mockURL() });

			tmpClient.dispatchStream({ Capability: 'X', Action: 'Y' }, null, (pError) =>
			{
				Expect(pError).to.be.an('error');
				Expect(pError.message).to.contain('bad capability');
				fDone();
			});
		});
	});

	// --------------------------------------------------------------
	suite('getStatus()', () =>
	{
		test('returns the /Beacon/Capabilities payload', (fDone) =>
		{
			setMockHandler('GET /Beacon/Capabilities', (pRecord, pRequest, pResponse) =>
			{
				pResponse.writeHead(200, { 'Content-Type': 'application/json' });
				pResponse.end(JSON.stringify({
					Capabilities: ['MeadowProxy', 'DataBeaconAccess'],
					BeaconCount: 3
				}));
			});

			let tmpClient = new libFableUltravisorClient({ UltravisorURL: mockURL() });
			tmpClient.getStatus((pError, pResult) =>
			{
				Expect(pError).to.equal(null);
				Expect(pResult.BeaconCount).to.equal(3);
				Expect(pResult.Capabilities).to.include('MeadowProxy');
				fDone();
			});
		});
	});

	// --------------------------------------------------------------
	suite('request() — timeout handling', () =>
	{
		test('aborts when TimeoutMs elapses before a response', (fDone) =>
		{
			setMockHandler('GET /Slow', (pRecord, pRequest, pResponse) =>
			{
				// Never write a response — let the client time out
				setTimeout(() => { try { pResponse.end(); } catch (e) {} }, 5000);
			});

			let tmpClient = new libFableUltravisorClient({ UltravisorURL: mockURL() });
			let tmpStart = Date.now();
			tmpClient.request('GET', '/Slow', null, (pError) =>
			{
				let tmpElapsed = Date.now() - tmpStart;
				Expect(pError).to.be.an('error');
				Expect(tmpElapsed).to.be.lessThan(1500);
				fDone();
			}, { TimeoutMs: 250 });
		});
	});
});
