const { fhirClient } = require('./client');

/**
 * Fetch raw MedicationRequest resource from FHIR server by ID
 * @param {string} id - MedicationRequest resource ID
 * @returns {Promise<Object>} Raw FHIR resource
 */
async function fetchMedicationRequest(id) {
  if (!id) {
    throw new Error('MedicationRequest ID is required');
  }

  try {
    const response = await fhirClient.get(`/MedicationRequest/${id}`);
    return response.data;
  } catch (error) {
    if (error.response && error.response.status === 404) {
      throw new Error(`MedicationRequest with ID '${id}' not found`);
    }
    throw new Error(`Failed to fetch MedicationRequest '${id}': ${error.message}`);
  }
}

/**
 * Parse raw FHIR MedicationRequest resource into standardized prescription object
 * @param {Object} resource - Raw FHIR MedicationRequest JSON
 * @returns {Object} Extracted prescription details
 */
function parseMedicationRequest(resource) {
  if (!resource || resource.resourceType !== 'MedicationRequest') {
    throw new Error('Invalid resource type. Expected MedicationRequest.');
  }

  const codeableConcept = resource.medicationCodeableConcept || {};
  const codings = codeableConcept.coding || [];
  const primaryCoding = codings[0] || {};

  const drugName = codeableConcept.text || primaryCoding.display || 'Unknown Drug';
  const rxNormCode = primaryCoding.code || null;
  const system = primaryCoding.system || null;

  const dosageInstructions = resource.dosageInstruction || [];
  const dosageText = dosageInstructions[0] ? dosageInstructions[0].text : 'No dosage specified';

  const patientRef = resource.subject ? resource.subject.reference : null;

  return {
    id: resource.id,
    status: resource.status || 'unknown',
    intent: resource.intent || 'unknown',
    patientRef,
    drugName,
    rxNormCode,
    system,
    dosage: dosageText,
    raw: resource
  };
}

/**
 * Fetch and parse MedicationRequest by ID in a single step
 * @param {string} id - MedicationRequest resource ID
 * @returns {Promise<Object>} Standardized prescription object
 */
async function getPrescriptionById(id) {
  const resource = await fetchMedicationRequest(id);
  return parseMedicationRequest(resource);
}

/**
 * Create a new MedicationRequest resource on the FHIR server
 * @param {Object} prescriptionData - MedicationRequest FHIR resource or partial data
 * @returns {Promise<Object>} Created raw FHIR resource
 */
async function createMedicationRequest(prescriptionData) {
  try {
    const response = await fhirClient.post('/MedicationRequest', prescriptionData);
    return response.data;
  } catch (error) {
    throw new Error(`Failed to create MedicationRequest: ${error.message}`);
  }
}

module.exports = {
  fetchMedicationRequest,
  parseMedicationRequest,
  getPrescriptionById,
  createMedicationRequest
};
