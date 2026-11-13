// @ts-check
'use strict';

/**
 * Handles incoming verification requests from mobile companion clients.
 *
 * @param {{
 *   body: any,
 *   pairingEngine: {
 *     verifyPairingChallenge: Function
 *   }
 * }} params
 * @returns {Promise<{ status: number, body: any }>}
 */
async function handlePairVerify({ body, pairingEngine }) {
  if (!body || typeof body !== 'object') {
    return {
      status: 400,
      body: { ok: false, error: 'Request body must be a JSON object.' },
    };
  }

  const challengeId = typeof body.challengeId === 'string' ? body.challengeId.trim() : '';
  const nonce = typeof body.nonce === 'string' ? body.nonce.trim() : '';

  if (!challengeId || !nonce) {
    return {
      status: 400,
      body: { ok: false, error: 'challengeId and nonce are required.' },
    };
  }

  const deviceName = typeof body.deviceName === 'string' ? body.deviceName.trim() : 'Android Companion';
  const clientPublicKey = typeof body.clientPublicKey === 'string' ? body.clientPublicKey : '';
  const providedCode = typeof body.providedCode === 'string' ? body.providedCode.trim() : '';

  try {
    const outcome = await pairingEngine.verifyPairingChallenge({
      challengeId,
      nonce,
      deviceName,
      clientPublicKey,
      providedCode,
    });

    if (!outcome || !outcome.ok) {
      return {
        status: 400,
        body: { ok: false, error: (outcome && outcome.error) || 'Pairing challenge verification failed.' },
      };
    }

    return {
      status: 200,
      body: {
        ok: true,
        deviceId: outcome.deviceId,
        deviceToken: outcome.deviceToken,
        deviceName: outcome.deviceName,
      },
    };
  } catch (err) {
    return {
      status: 500,
      body: { ok: false, error: err.message || 'Internal error verifying pairing challenge.' },
    };
  }
}

/**
 * Handles pairing challenge status check requests.
 *
 * @param {{
 *   queryParams: URLSearchParams,
 *   pairingEngine: {
 *     getChallengeStatus: Function
 *   }
 * }} params
 * @returns {Promise<{ status: number, body: any }>}
 */
async function handlePairStatus({ queryParams, pairingEngine }) {
  const ch = queryParams ? queryParams.get('ch') : null;

  if (!ch || typeof ch !== 'string' || !ch.trim()) {
    return {
      status: 400,
      body: { ok: false, error: 'ch query parameter is required.' },
    };
  }

  try {
    const outcome = await pairingEngine.getChallengeStatus(ch.trim());
    if (!outcome || !outcome.ok) {
      return {
        status: 404,
        body: { ok: false, error: (outcome && outcome.error) || 'Challenge not found.' },
      };
    }

    return {
      status: 200,
      body: outcome,
    };
  } catch (err) {
    return {
      status: 500,
      body: { ok: false, error: err.message || 'Internal error checking challenge status.' },
    };
  }
}

module.exports = {
  handlePairVerify,
  handlePairStatus,
};
