const axios = require('axios');

const fhirBaseUrl = process.env.FHIR_BASE_URL || 'http://localhost:8080/fhir';

const fhirClient = axios.create({
  baseURL: fhirBaseUrl,
  headers: {
    'Content-Type': 'application/fhir+json',
    'Accept': 'application/fhir+json'
  }
});

/**
 * Health check for FHIR server connection
 */
async function checkFhirServer() {
  try {
    const response = await fhirClient.get('/metadata');
    return { status: 'ok', fhirVersion: response.data.fhirVersion || 'R4' };
  } catch (error) {
    return { status: 'error', message: error.message };
  }
}

module.exports = {
  fhirClient,
  checkFhirServer
};
