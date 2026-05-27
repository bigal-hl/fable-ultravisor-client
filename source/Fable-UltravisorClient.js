/**
 * Fable Ultravisor Client
 *
 * Fable service for talking to an Ultravisor beacon coordinator.
 *
 * Surface:
 *   - authenticate(fCallback)                      — POST /1.0/Authenticate, captures session cookie
 *   - request(pMethod, pPath, pBody, fCallback)    — generic JSON HTTP round-trip
 *   - dispatch(pWorkItem, fCallback)               — POST /Beacon/Work/Dispatch (synchronous JSON)
 *   - dispatchStream(pWorkItem, pCallbacks, fCallback) — POST /Beacon/Work/DispatchStream (binary frames)
 *   - triggerOperation(pHash, pParameters, fCallback)  — POST /Operation/{hash}/Trigger
 *   - getStatus(fCallback)                         — GET /Beacon/Capabilities
 *
 * Settings (via constructor options):
 *   - UltravisorURL      — base URL, required for any request
 *   - UserName           — used by authenticate()
 *   - Password           — used by authenticate(), default empty
 *
 * Multiple instances can coexist with different URLs/users. Each instance owns
 * its own session cookie.
 *
 * @license MIT
 * @author <steven@velozo.com>
 */
const libFableServiceProviderBase = require('fable-serviceproviderbase');
const libHTTP = require('http');
const libHTTPS = require('https');

const libPackage = require('../package.json');

// Frame type codes (binary-frames-v1) for dispatchStream
const FRAME_TYPE_PROGRESS     = 0x01;
const FRAME_TYPE_DATA         = 0x02;
const FRAME_TYPE_BINARY_FINAL = 0x03;
const FRAME_TYPE_RESULT       = 0x04;
const FRAME_TYPE_ERROR        = 0x05;

class FableUltravisorClient extends libFableServiceProviderBase
{
	constructor(pFable, pOptions, pServiceHash)
	{
		super(pFable, pOptions, pServiceHash);

		this.serviceType = 'UltravisorClient';
		this._Package = libPackage;

		// Settings: accept via options or fall back to fable.settings.UltravisorClient
		let tmpFallback = (this.fable && this.fable.settings && this.fable.settings.UltravisorClient) || {};
		let tmpOpts = this.options || {};

		this._UltravisorURL = tmpOpts.UltravisorURL || tmpFallback.UltravisorURL || '';
		this._UserName = tmpOpts.UserName || tmpFallback.UserName || '';
		this._Password = (typeof(tmpOpts.Password) === 'string') ? tmpOpts.Password
							: (typeof(tmpFallback.Password) === 'string') ? tmpFallback.Password
							: '';

		// Session cookie captured from /1.0/Authenticate
		this._SessionCookie = null;
	}

	/**
	 * Reconfigure the client at runtime. Clears the current session cookie.
	 *
	 * @param {object} pConfig - { UltravisorURL, UserName, Password }
	 */
	configure(pConfig)
	{
		if (typeof(pConfig) !== 'object' || pConfig === null)
		{
			return;
		}
		if (typeof(pConfig.UltravisorURL) === 'string') { this._UltravisorURL = pConfig.UltravisorURL; }
		if (typeof(pConfig.UserName) === 'string')      { this._UserName = pConfig.UserName; }
		if (typeof(pConfig.Password) === 'string')      { this._Password = pConfig.Password; }

		this._SessionCookie = null;
	}

	/**
	 * True when the client has enough configuration to make requests.
	 *
	 * @returns {boolean}
	 */
	isConfigured()
	{
		return (typeof(this._UltravisorURL) === 'string') && (this._UltravisorURL.length > 0);
	}

	/**
	 * Access the currently captured session cookie (for diagnostics).
	 *
	 * @returns {string|null}
	 */
	getSessionCookie()
	{
		return this._SessionCookie;
	}

	// ================================================================
	// Authentication
	// ================================================================

	/**
	 * Authenticate against /1.0/Authenticate and capture the session cookie.
	 *
	 * @param {function} fCallback - function(pError)
	 */
	authenticate(fCallback)
	{
		if (!this.isConfigured())
		{
			return fCallback(new Error('UltravisorClient: UltravisorURL is not configured.'));
		}

		let tmpSelf = this;
		let tmpBody = {
			UserName: this._UserName,
			Password: this._Password
		};
		let tmpBodyString = JSON.stringify(tmpBody);

		let tmpParsedURL;
		try
		{
			tmpParsedURL = new URL(this._UltravisorURL);
		}
		catch (pError)
		{
			return fCallback(new Error('UltravisorClient: Invalid UltravisorURL: ' + this._UltravisorURL));
		}

		let tmpLib = (tmpParsedURL.protocol === 'https:') ? libHTTPS : libHTTP;

		let tmpOptions = {
			hostname: tmpParsedURL.hostname,
			port: tmpParsedURL.port || ((tmpParsedURL.protocol === 'https:') ? 443 : 80),
			path: '/1.0/Authenticate',
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				'Content-Length': Buffer.byteLength(tmpBodyString)
			}
		};

		let tmpReq = tmpLib.request(tmpOptions, (pResponse) =>
		{
			let tmpData = '';
			pResponse.on('data', (pChunk) => { tmpData += pChunk; });
			pResponse.on('end', () =>
			{
				if (pResponse.statusCode >= 400)
				{
					return fCallback(new Error(`UltravisorClient: authentication failed: HTTP ${pResponse.statusCode}`));
				}

				// UV's orator-authentication returns HTTP 200 with body
				// `{ LoggedIn: false, Error: 'Authentication failed.' }`
				// when the credentials don't validate against the auth-
				// beacon — and crucially does NOT send a Set-Cookie header
				// in that case. If we only check statusCode we end up with
				// a "successful" auth that left _SessionCookie=null, and
				// every later dispatch goes out with no Cookie and gets
				// 401'd by UV's _requireSession middleware. Parse the body
				// and surface the real failure so callers can react instead
				// of silently dispatching as anonymous.
				let tmpParsedBody = null;
				if (tmpData && tmpData.length > 0)
				{
					try { tmpParsedBody = JSON.parse(tmpData); }
					catch (pParseError) { /* leave null — UV may have sent a non-JSON body */ }
				}
				if (tmpParsedBody && tmpParsedBody.LoggedIn === false)
				{
					let tmpReason = tmpParsedBody.Error || 'authentication rejected by UV (LoggedIn:false)';
					return fCallback(new Error(`UltravisorClient: authentication failed for [${tmpSelf._UserName}]: ${tmpReason}`));
				}

				let tmpSetCookieHeaders = pResponse.headers['set-cookie'];
				if (tmpSetCookieHeaders && tmpSetCookieHeaders.length > 0)
				{
					let tmpCookieParts = tmpSetCookieHeaders[0].split(';');
					tmpSelf._SessionCookie = tmpCookieParts[0].trim();
					if (tmpSelf.log)
					{
						tmpSelf.log.info(`UltravisorClient: authenticated as [${tmpSelf._UserName}] against ${tmpSelf._UltravisorURL}`);
					}
				}
				else
				{
					// HTTP 200 + no LoggedIn:false marker + no Set-Cookie
					// is still a problem (we have no session to attach to
					// future requests). Surface it as an error so the
					// caller doesn't proceed thinking it's authenticated.
					return fCallback(new Error(`UltravisorClient: authentication for [${tmpSelf._UserName}] returned no session cookie (body: ${tmpData.substring(0, 200)})`));
				}

				return fCallback(null);
			});
			pResponse.on('error', fCallback);
		});

		tmpReq.on('error', fCallback);
		tmpReq.write(tmpBodyString);
		tmpReq.end();
	}

	// ================================================================
	// Generic JSON request
	// ================================================================

	/**
	 * Make an HTTP request to the Ultravisor server.
	 *
	 * @param {string} pMethod - HTTP method
	 * @param {string} pPath - URL path
	 * @param {object|null} pBody - Request body (JSON)
	 * @param {function} fCallback - function(pError, pResult)
	 * @param {object} [pOptions] - { TimeoutMs } to cap the socket timeout (0 = infinite, default 0)
	 */
	request(pMethod, pPath, pBody, fCallback, pOptions)
	{
		if (!this.isConfigured())
		{
			return fCallback(new Error('UltravisorClient: UltravisorURL is not configured.'));
		}

		let tmpParsedURL;
		try
		{
			tmpParsedURL = new URL(this._UltravisorURL);
		}
		catch (pError)
		{
			return fCallback(new Error('UltravisorClient: Invalid UltravisorURL: ' + this._UltravisorURL));
		}

		let tmpLib = (tmpParsedURL.protocol === 'https:') ? libHTTPS : libHTTP;

		let tmpHeaders = {
			'Content-Type': 'application/json',
			'Connection': 'keep-alive'
		};
		if (this._SessionCookie)
		{
			tmpHeaders['Cookie'] = this._SessionCookie;
		}

		let tmpReqOptions = {
			hostname: tmpParsedURL.hostname,
			port: tmpParsedURL.port || ((tmpParsedURL.protocol === 'https:') ? 443 : 80),
			path: pPath,
			method: pMethod,
			headers: tmpHeaders
		};

		let tmpCallbackFired = false;
		let tmpComplete = (pError, pResult) =>
		{
			if (tmpCallbackFired) { return; }
			tmpCallbackFired = true;
			return fCallback(pError, pResult);
		};

		let tmpReq = tmpLib.request(tmpReqOptions, (pResponse) =>
		{
			let tmpData = '';
			pResponse.on('data', (pChunk) => { tmpData += pChunk; });
			pResponse.on('end', () =>
			{
				try
				{
					let tmpParsed = tmpData.length > 0 ? JSON.parse(tmpData) : {};
					if (pResponse.statusCode >= 400)
					{
						return tmpComplete(new Error(tmpParsed.Error || `UltravisorClient: HTTP ${pResponse.statusCode}`));
					}
					return tmpComplete(null, tmpParsed);
				}
				catch (pParseError)
				{
					return tmpComplete(new Error(`UltravisorClient: invalid JSON response: ${tmpData.substring(0, 200)}`));
				}
			});
			pResponse.on('error', tmpComplete);
		});

		tmpReq.on('error', tmpComplete);

		// Timeout: default 0 (infinite) to preserve retold-remote's long-operation behavior.
		// Callers that want to bound a CRUD request should pass pOptions.TimeoutMs.
		let tmpTimeoutMs = (pOptions && typeof(pOptions.TimeoutMs) === 'number') ? pOptions.TimeoutMs : 0;
		tmpReq.setTimeout(tmpTimeoutMs, () =>
		{
			tmpReq.destroy(new Error(`UltravisorClient: request timeout after ${tmpTimeoutMs}ms`));
		});

		if (pBody && (pMethod === 'POST' || pMethod === 'PUT' || pMethod === 'PATCH'))
		{
			tmpReq.write(JSON.stringify(pBody));
		}

		tmpReq.end();
	}

	// ================================================================
	// Work item dispatch (synchronous JSON)
	// ================================================================

	/**
	 * Dispatch a work item to the Ultravisor coordinator and wait for the
	 * synchronous JSON result.
	 *
	 * Work item shape:
	 *   { Capability, Action, Settings, AffinityKey, TimeoutMs }
	 *
	 * @param {object} pWorkItem
	 * @param {function} fCallback - function(pError, pResult)
	 *   pResult is the JSON body returned by /Beacon/Work/Dispatch — typically
	 *   an Outputs envelope from the beacon handler.
	 */
	dispatch(pWorkItem, fCallback)
	{
		if (!pWorkItem || typeof(pWorkItem) !== 'object')
		{
			return fCallback(new Error('UltravisorClient: dispatch requires a work item object.'));
		}
		if (!pWorkItem.Capability)
		{
			return fCallback(new Error('UltravisorClient: dispatch work item requires Capability.'));
		}

		// Callers pass TimeoutMs on the work item itself; we also use it to bound
		// the HTTP socket so stuck dispatches don't hang indefinitely.
		let tmpTimeoutMs = (typeof(pWorkItem.TimeoutMs) === 'number' && pWorkItem.TimeoutMs > 0)
			? pWorkItem.TimeoutMs + 5000
			: 0;

		this.request('POST', '/Beacon/Work/Dispatch', pWorkItem, fCallback, { TimeoutMs: tmpTimeoutMs });
	}

	// ================================================================
	// Work item dispatch (binary-framed streaming)
	// ================================================================

	/**
	 * Dispatch a work item with binary-framed streaming. Progress, intermediate
	 * binary data, and the final result arrive as framed chunks.
	 *
	 * Frame protocol (binary-frames-v1):
	 *   [1 byte type][4 bytes payload length (uint32 BE)][payload]
	 *   0x01 Progress      (JSON)
	 *   0x02 Intermediate  (binary)
	 *   0x03 Final output  (binary)
	 *   0x04 Result        (JSON)
	 *   0x05 Error         (JSON, non-fatal notification)
	 *
	 * @param {object} pWorkItem
	 * @param {object} pCallbacks - { onProgress, onBinaryData, onError }
	 * @param {function} fCallback - function(pError, pResult)
	 *   pResult includes OutputBuffer (Buffer) if final binary output streamed.
	 */
	dispatchStream(pWorkItem, pCallbacks, fCallback)
	{
		if (!this.isConfigured())
		{
			return fCallback(new Error('UltravisorClient: UltravisorURL is not configured.'));
		}

		let tmpParsedURL;
		try
		{
			tmpParsedURL = new URL(this._UltravisorURL);
		}
		catch (pError)
		{
			return fCallback(new Error('UltravisorClient: Invalid UltravisorURL: ' + this._UltravisorURL));
		}

		let tmpLib = (tmpParsedURL.protocol === 'https:') ? libHTTPS : libHTTP;

		let tmpStreamHeaders = {
			'Content-Type': 'application/json',
			'Connection': 'keep-alive'
		};
		if (this._SessionCookie)
		{
			tmpStreamHeaders['Cookie'] = this._SessionCookie;
		}

		let tmpOptions = {
			hostname: tmpParsedURL.hostname,
			port: tmpParsedURL.port || ((tmpParsedURL.protocol === 'https:') ? 443 : 80),
			path: '/Beacon/Work/DispatchStream',
			method: 'POST',
			headers: tmpStreamHeaders
		};

		let tmpCallbackFired = false;
		let tmpComplete = (pError, pResult) =>
		{
			if (tmpCallbackFired) { return; }
			tmpCallbackFired = true;
			fCallback(pError, pResult);
		};

		let tmpReq = tmpLib.request(tmpOptions, (pResponse) =>
		{
			// Non-streaming error response (4xx/5xx before stream starts)
			if (pResponse.statusCode >= 400)
			{
				let tmpData = '';
				pResponse.on('data', (pChunk) => { tmpData += pChunk; });
				pResponse.on('end', () =>
				{
					try
					{
						let tmpParsed = JSON.parse(tmpData);
						tmpComplete(new Error(tmpParsed.Error || `UltravisorClient: HTTP ${pResponse.statusCode}`));
					}
					catch (pParseError)
					{
						tmpComplete(new Error(`UltravisorClient: HTTP ${pResponse.statusCode}: ${tmpData.substring(0, 200)}`));
					}
				});
				pResponse.on('error', tmpComplete);
				return;
			}

			// Binary frame stream parser
			let tmpBuffer = Buffer.alloc(0);
			let tmpLastResult = null;
			let tmpBinaryChunks = [];

			pResponse.on('data', (pChunk) =>
			{
				tmpBuffer = Buffer.concat([tmpBuffer, pChunk]);

				while (tmpBuffer.length >= 5)
				{
					let tmpPayloadLen = tmpBuffer.readUInt32BE(1);

					if (tmpBuffer.length < 5 + tmpPayloadLen)
					{
						break;
					}

					let tmpType = tmpBuffer.readUInt8(0);
					let tmpPayload = tmpBuffer.slice(5, 5 + tmpPayloadLen);
					tmpBuffer = tmpBuffer.slice(5 + tmpPayloadLen);

					switch (tmpType)
					{
						case FRAME_TYPE_PROGRESS:
							if (pCallbacks && pCallbacks.onProgress)
							{
								try
								{
									pCallbacks.onProgress(JSON.parse(tmpPayload.toString()));
								}
								catch (pParseError)
								{
									// Ignore malformed progress frames
								}
							}
							break;

						case FRAME_TYPE_DATA:
							if (pCallbacks && pCallbacks.onBinaryData)
							{
								pCallbacks.onBinaryData(Buffer.from(tmpPayload));
							}
							break;

						case FRAME_TYPE_BINARY_FINAL:
							tmpBinaryChunks.push(Buffer.from(tmpPayload));
							break;

						case FRAME_TYPE_RESULT:
							try
							{
								tmpLastResult = JSON.parse(tmpPayload.toString());
							}
							catch (pParseError)
							{
								// Ignore malformed result frames
							}
							break;

						case FRAME_TYPE_ERROR:
							if (pCallbacks && pCallbacks.onError)
							{
								try
								{
									pCallbacks.onError(JSON.parse(tmpPayload.toString()));
								}
								catch (pParseError)
								{
									// Ignore malformed error frames
								}
							}
							break;
					}
				}
			});

			pResponse.on('end', () =>
			{
				if (tmpLastResult)
				{
					if (tmpBinaryChunks.length > 0)
					{
						tmpLastResult.OutputBuffer = Buffer.concat(tmpBinaryChunks);
					}
					tmpComplete(null, tmpLastResult);
				}
				else
				{
					tmpComplete(new Error('UltravisorClient: stream ended without result frame'));
				}
			});

			pResponse.on('error', tmpComplete);
		});

		tmpReq.on('error', tmpComplete);

		// Disable socket timeout for long-running streaming dispatch
		tmpReq.setTimeout(0);

		tmpReq.write(JSON.stringify(pWorkItem));
		tmpReq.end();
	}

	// ================================================================
	// Operation trigger (high-level)
	// ================================================================

	/**
	 * Trigger a pre-configured Ultravisor operation by hash. Returns either a
	 * binary buffer (octet-stream responses) or a parsed JSON envelope.
	 *
	 * @param {string} pOperationHash
	 * @param {object} pParameters - Seeded into OperationState
	 * @param {function} fCallback - function(pError, pResult)
	 */
	triggerOperation(pOperationHash, pParameters, fCallback)
	{
		if (!this.isConfigured())
		{
			return fCallback(new Error('UltravisorClient: UltravisorURL is not configured.'));
		}

		let tmpBody = JSON.stringify({
			Parameters: pParameters || {},
			Async: false,
			TimeoutMs: (pParameters && pParameters.TimeoutMs) || 300000
		});

		let tmpParsedURL;
		try
		{
			tmpParsedURL = new URL(this._UltravisorURL);
		}
		catch (pURLError)
		{
			return fCallback(new Error('UltravisorClient: Invalid UltravisorURL: ' + this._UltravisorURL));
		}

		let tmpLib = (tmpParsedURL.protocol === 'https:') ? libHTTPS : libHTTP;

		let tmpHeaders = {
			'Content-Type': 'application/json',
			'Content-Length': Buffer.byteLength(tmpBody),
			'Connection': 'keep-alive'
		};
		if (this._SessionCookie)
		{
			tmpHeaders['Cookie'] = this._SessionCookie;
		}

		let tmpOptions = {
			hostname: tmpParsedURL.hostname,
			port: tmpParsedURL.port || ((tmpParsedURL.protocol === 'https:') ? 443 : 80),
			path: '/Operation/' + encodeURIComponent(pOperationHash) + '/Trigger',
			method: 'POST',
			headers: tmpHeaders
		};

		let tmpCallbackFired = false;
		let tmpComplete = (pError, pResult) =>
		{
			if (tmpCallbackFired) { return; }
			tmpCallbackFired = true;
			return fCallback(pError, pResult);
		};

		let tmpReq = tmpLib.request(tmpOptions, (pResponse) =>
		{
			let tmpContentType = pResponse.headers['content-type'] || '';

			if (tmpContentType.indexOf('application/octet-stream') >= 0)
			{
				let tmpChunks = [];
				pResponse.on('data', (pChunk) => { tmpChunks.push(pChunk); });
				pResponse.on('end', () =>
				{
					let tmpBuffer = Buffer.concat(tmpChunks);
					let tmpResult = {
						Success: true,
						OutputBuffer: tmpBuffer,
						RunHash: pResponse.headers['x-run-hash'] || '',
						Status: pResponse.headers['x-status'] || 'Complete',
						ElapsedMs: parseInt(pResponse.headers['x-elapsed-ms'] || '0', 10)
					};
					return tmpComplete(null, tmpResult);
				});
				pResponse.on('error', tmpComplete);
			}
			else
			{
				let tmpData = '';
				pResponse.on('data', (pChunk) => { tmpData += pChunk; });
				pResponse.on('end', () =>
				{
					try
					{
						let tmpParsed = JSON.parse(tmpData);
						if (pResponse.statusCode >= 400)
						{
							return tmpComplete(new Error(tmpParsed.Error || `UltravisorClient: HTTP ${pResponse.statusCode}`));
						}
						if (!tmpParsed.Success)
						{
							return tmpComplete(new Error(
								(tmpParsed.Errors && tmpParsed.Errors.length > 0)
									? tmpParsed.Errors[0]
									: 'UltravisorClient: operation trigger failed'));
						}
						return tmpComplete(null, tmpParsed);
					}
					catch (pParseError)
					{
						return tmpComplete(new Error('UltravisorClient: invalid response from trigger'));
					}
				});
				pResponse.on('error', tmpComplete);
			}
		});

		tmpReq.on('error', tmpComplete);
		tmpReq.setTimeout(0);
		tmpReq.write(tmpBody);
		tmpReq.end();
	}

	// ================================================================
	// Status
	// ================================================================

	/**
	 * GET /Beacon/Capabilities — returns the current capabilities advertised
	 * by connected beacons and the beacon count. Useful for health checks.
	 *
	 * @param {function} fCallback - function(pError, pResult)
	 */
	getStatus(fCallback)
	{
		this.request('GET', '/Beacon/Capabilities', null, fCallback);
	}
}

function autoConstruct(pFable, pOptions, pServiceHash)
{
	return new FableUltravisorClient(pFable, pOptions, pServiceHash);
}

module.exports = FableUltravisorClient;
module.exports.new = autoConstruct;
