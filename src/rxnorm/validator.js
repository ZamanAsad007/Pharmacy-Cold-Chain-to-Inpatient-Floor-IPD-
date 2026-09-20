const https = require('https');
const axios = require('axios');

const RXNAV_BASE_URL = process.env.RXNAV_BASE_URL || 'https://rxnav.nlm.nih.gov/REST';

const rxNavClient = axios.create({
  baseURL: RXNAV_BASE_URL,
  timeout: 8000,
  httpsAgent: new https.Agent({ family: 4 }),
  headers: {
    Accept: 'application/json'
  }
});

/**
 * Query RxNav to get standardized RxNorm concept identifier (RxCUI) for a drug name
 * @param {string} drugName - The name or term of the drug
 * @returns {Promise<{rxcui: string|null, candidates: Array<string>}>}
 */
async function queryRxNormByName(drugName) {
  if (!drugName || typeof drugName !== 'string' || drugName.trim().length === 0) {
    throw new Error('Valid drug name is required');
  }

  const cleanName = drugName.trim();

  try {
    // 1. Direct match query
    const directResponse = await rxNavClient.get('/rxcui.json', {
      params: { name: cleanName }
    });

    const directIds = directResponse.data?.idGroup?.rxnormId;
    if (Array.isArray(directIds) && directIds.length > 0) {
      return {
        rxcui: directIds[0],
        candidates: directIds
      };
    }

    // 2. Fallback: Approximate match query
    const approxResponse = await rxNavClient.get('/approximateTerm.json', {
      params: { term: cleanName, maxEntries: 4 }
    });

    const candidates = approxResponse.data?.approximateGroup?.candidate || [];
    const validCandidateIds = candidates
      .filter(c => c.rxcui)
      .map(c => c.rxcui);

    if (validCandidateIds.length > 0) {
      return {
        rxcui: validCandidateIds[0],
        candidates: validCandidateIds
      };
    }

    return {
      rxcui: null,
      candidates: []
    };
  } catch (error) {
    throw new Error(`RxNav API query failed: ${error.message}`);
  }
}

/**
 * Fetch official concept properties for a given RxCUI
 * @param {string} rxcui - Standardized RxNorm code
 * @returns {Promise<Object|null>}
 */
async function getRxNormProperties(rxcui) {
  if (!rxcui) return null;

  try {
    const response = await rxNavClient.get(`/rxcui/${rxcui}/properties.json`);
    const props = response.data?.properties;
    if (!props || !props.rxcui) {
      return null;
    }

    return {
      rxcui: props.rxcui,
      name: props.name,
      synonym: props.synonym || '',
      tty: props.tty || ''
    };
  } catch (error) {
    if (error.response && error.response.status === 404) {
      return null;
    }
    throw new Error(`Failed to fetch RxNorm properties for RxCUI '${rxcui}': ${error.message}`);
  }
}

/**
 * Validate drug name and compare against expected RxNorm code from prescription
 * @param {string} drugName - Drug name from prescription
 * @param {string} [expectedRxNormCode] - RxNorm code declared on the prescription
 * @returns {Promise<Object>} Pass/Fail validation result
 */
async function validateDrug(drugName, expectedRxNormCode = null) {
  if (!drugName) {
    return {
      valid: false,
      reason: 'No drug name provided',
      drugName: null,
      rxNormCode: null,
      details: null
    };
  }

  const lookupResult = await queryRxNormByName(drugName);

  if (!lookupResult.rxcui) {
    return {
      valid: false,
      reason: `Drug '${drugName}' was not found in RxNorm database`,
      drugName,
      rxNormCode: null,
      details: null
    };
  }

  // If prescription had an expected RxNorm code, verify if it matches any candidate
  if (expectedRxNormCode) {
    const expectedMatches = lookupResult.candidates.includes(String(expectedRxNormCode));

    // Also check reverse: if the expected code itself exists and has properties matching the drug
    let codeProperties = null;
    if (!expectedMatches) {
      codeProperties = await getRxNormProperties(expectedRxNormCode);
    }

    const codeVerified = expectedMatches || (codeProperties && codeProperties.rxcui === String(expectedRxNormCode));

    if (!codeVerified) {
      return {
        valid: false,
        reason: `Prescription RxNorm code '${expectedRxNormCode}' does not match RxNav verified code '${lookupResult.rxcui}'`,
        drugName,
        expectedRxNormCode,
        verifiedRxNormCode: lookupResult.rxcui,
        details: null
      };
    }
  }

  // Fetch official drug properties
  const officialProps = await getRxNormProperties(lookupResult.rxcui);

  return {
    valid: true,
    drugName,
    rxNormCode: lookupResult.rxcui,
    matchedCandidates: lookupResult.candidates,
    details: officialProps || { rxcui: lookupResult.rxcui, name: drugName }
  };
}

/**
 * Validate a parsed prescription object (from Phase 1)
 * @param {Object} prescription - Parsed prescription domain object
 * @returns {Promise<Object>}
 */
async function validatePrescription(prescription) {
  if (!prescription) {
    throw new Error('Prescription object is required');
  }

  const { drugName, rxNormCode, id } = prescription;
  const validation = await validateDrug(drugName, rxNormCode);

  return {
    prescriptionId: id,
    ...validation
  };
}

module.exports = {
  rxNavClient,
  queryRxNormByName,
  getRxNormProperties,
  validateDrug,
  validatePrescription
};
