const { fhirClient } = require('./client');

const ETA_EXTENSION_URL = 'http://pharmacy-cold-chain.org/fhir/StructureDefinition/expected-delivery-time';
const DISPENSE_PERFORMER_SYSTEM = 'http://terminology.hl7.org/CodeSystem/medicationdispense-performer-role';

/**
 * Construct a valid FHIR R4 MedicationDispense resource
 * @param {Object} options - Dispense configuration options
 * @param {string|number} options.prescriptionId - MedicationRequest ID (or medicationRequestId)
 * @param {string|number} options.medicationRequestId - Alias for prescriptionId
 * @param {string} options.patientRef - Patient reference (e.g. 'Patient/1' or '1')
 * @param {string} [options.drugName] - Name of medication dispensed
 * @param {string} [options.rxNormCode] - RxNorm code for the drug
 * @param {Object} [options.medicationCodeableConcept] - Complete FHIR CodeableConcept
 * @param {string|Object} options.packer - Packer details (string name or { name, reference })
 * @param {string|Object} options.courier - Courier details (string name or { name, reference })
 * @param {string|Date} options.eta - Expected arrival time (ISO string or Date)
 * @param {string} [options.status='in-progress'] - Dispense status (e.g. 'in-progress', 'completed')
 * @param {string|Date} [options.whenPrepared] - Timestamp when package was prepared
 * @param {string|Date} [options.whenHandedOver] - Timestamp when package was handed to courier
 * @param {string|Array<string>} [options.note] - Handling or clinical notes (e.g., cold chain alert)
 * @returns {Object} Valid FHIR R4 MedicationDispense resource
 */
function buildMedicationDispense(options = {}) {
  const prescriptionId = options.prescriptionId || options.medicationRequestId;
  if (!prescriptionId) {
    throw new Error('Prescription reference (medicationRequestId or prescriptionId) is required');
  }

  const patientRef = options.patientRef || options.subject?.reference || options.subject;
  if (!patientRef) {
    throw new Error('Patient reference (patientRef) is required');
  }

  if (!options.packer) {
    throw new Error('Packer information (packer) is required');
  }

  if (!options.courier) {
    throw new Error('Courier information (courier) is required');
  }

  if (!options.eta) {
    throw new Error('Expected arrival time (eta) is required');
  }

  const formattedPrescriptionRef = String(prescriptionId).startsWith('MedicationRequest/')
    ? String(prescriptionId)
    : `MedicationRequest/${prescriptionId}`;

  const formattedPatientRef = String(patientRef).startsWith('Patient/')
    ? String(patientRef)
    : `Patient/${patientRef}`;

  const etaIso = new Date(options.eta).toISOString();
  const whenPreparedIso = options.whenPrepared
    ? new Date(options.whenPrepared).toISOString()
    : new Date().toISOString();
  const whenHandedOverIso = options.whenHandedOver
    ? new Date(options.whenHandedOver).toISOString()
    : whenPreparedIso;

  // Build medication CodeableConcept
  let medicationCodeableConcept = options.medicationCodeableConcept;
  if (!medicationCodeableConcept) {
    const codings = [];
    if (options.rxNormCode) {
      codings.push({
        system: 'http://www.nlm.nih.gov/research/umls/rxnorm',
        code: String(options.rxNormCode),
        display: options.drugName || 'Prescribed Medication'
      });
    }
    medicationCodeableConcept = {
      coding: codings,
      text: options.drugName || (codings[0] && codings[0].display) || 'Prescribed Medication'
    };
  }

  // Build performers (packer and courier)
  const performers = [];

  // Packer performer
  const packerActor = typeof options.packer === 'string'
    ? { display: options.packer }
    : {
        display: options.packer.name || options.packer.display || 'Packager',
        ...(options.packer.reference ? { reference: options.packer.reference } : {})
      };

  performers.push({
    function: {
      coding: [
        {
          system: DISPENSE_PERFORMER_SYSTEM,
          code: 'packager',
          display: 'Packager'
        }
      ],
      text: 'Packager'
    },
    actor: packerActor
  });

  // Courier performer
  const courierActor = typeof options.courier === 'string'
    ? { display: options.courier }
    : {
        display: options.courier.name || options.courier.display || 'Courier',
        ...(options.courier.reference ? { reference: options.courier.reference } : {})
      };

  performers.push({
    function: {
      coding: [
        {
          system: DISPENSE_PERFORMER_SYSTEM,
          code: 'courier',
          display: 'Courier'
        }
      ],
      text: 'Courier'
    },
    actor: courierActor
  });

  // Build notes
  let notes = [];
  if (options.note) {
    if (Array.isArray(options.note)) {
      notes = options.note.map(n => typeof n === 'string' ? { text: n } : n);
    } else if (typeof options.note === 'string') {
      notes = [{ text: options.note }];
    }
  }

  const resource = {
    resourceType: 'MedicationDispense',
    status: options.status || 'in-progress',
    medicationCodeableConcept,
    subject: {
      reference: formattedPatientRef
    },
    authorizingPrescription: [
      {
        reference: formattedPrescriptionRef
      }
    ],
    performer: performers,
    whenPrepared: whenPreparedIso,
    whenHandedOver: whenHandedOverIso,
    extension: [
      {
        url: ETA_EXTENSION_URL,
        valueDateTime: etaIso
      }
    ]
  };

  if (notes.length > 0) {
    resource.note = notes;
  }

  return resource;
}

/**
 * POST a MedicationDispense resource to the FHIR server
 * @param {Object} dispenseData - FHIR MedicationDispense resource
 * @returns {Promise<Object>} Created raw FHIR resource from server
 */
async function createMedicationDispense(dispenseData) {
  if (!dispenseData || typeof dispenseData !== 'object') {
    throw new Error('MedicationDispense payload is required');
  }

  try {
    const response = await fhirClient.post('/MedicationDispense', dispenseData);
    return response.data;
  } catch (error) {
    const diagnostics = error.response?.data?.issue?.[0]?.diagnostics;
    const detailMessage = diagnostics || error.response?.data?.message || error.message;
    throw new Error(`Failed to create MedicationDispense: ${detailMessage}`);
  }
}

/**
 * Fetch raw MedicationDispense resource from FHIR server by ID
 * @param {string} id - MedicationDispense resource ID
 * @returns {Promise<Object>} Raw FHIR resource
 */
async function fetchMedicationDispense(id) {
  if (!id) {
    throw new Error('MedicationDispense ID is required');
  }

  try {
    const response = await fhirClient.get(`/MedicationDispense/${id}`);
    return response.data;
  } catch (error) {
    if (error.response && error.response.status === 404) {
      throw new Error(`MedicationDispense with ID '${id}' not found`);
    }
    throw new Error(`Failed to fetch MedicationDispense '${id}': ${error.message}`);
  }
}

/**
 * Parse raw FHIR MedicationDispense resource into a clean, structured object
 * @param {Object} resource - Raw FHIR MedicationDispense JSON
 * @returns {Object} Structured dispense summary
 */
function parseMedicationDispense(resource) {
  if (!resource || resource.resourceType !== 'MedicationDispense') {
    throw new Error('Invalid resource type. Expected MedicationDispense.');
  }

  const codeableConcept = resource.medicationCodeableConcept || {};
  const codings = codeableConcept.coding || [];
  const primaryCoding = codings[0] || {};
  const drugName = codeableConcept.text || primaryCoding.display || 'Unknown Drug';
  const rxNormCode = primaryCoding.code || null;

  const patientRef = resource.subject?.reference || null;
  const authorizingPrescription = resource.authorizingPrescription?.[0]?.reference || null;

  // Extract performers
  const performers = resource.performer || [];

  const packerPerformer = performers.find(p => {
    const coding = p.function?.coding || [];
    return coding.some(c => c.code === 'packager' || c.code === 'packer' || c.code === 'preparer') ||
      (p.function?.text && /pack|prep/i.test(p.function.text));
  }) || performers[0];

  const courierPerformer = performers.find(p => {
    const coding = p.function?.coding || [];
    return coding.some(c => c.code === 'courier' || c.code === 'deliverer' || c.code === 'carrier') ||
      (p.function?.text && /courier|deliver|carrier/i.test(p.function.text));
  }) || (performers.length > 1 ? performers[1] : null);

  const packer = packerPerformer ? {
    name: packerPerformer.actor?.display || 'Unknown Packer',
    reference: packerPerformer.actor?.reference || null
  } : null;

  const courier = courierPerformer ? {
    name: courierPerformer.actor?.display || 'Unknown Courier',
    reference: courierPerformer.actor?.reference || null
  } : null;

  // Extract ETA from extension
  let eta = null;
  if (resource.extension && Array.isArray(resource.extension)) {
    const etaExt = resource.extension.find(ext =>
      ext.url && (ext.url.includes('expected-delivery-time') || ext.url.includes('eta'))
    );
    if (etaExt) {
      eta = etaExt.valueDateTime || etaExt.valueString || null;
    }
  }

  // Extract notes
  const notes = (resource.note || []).map(n => n.text).filter(Boolean);

  return {
    id: resource.id,
    status: resource.status || 'unknown',
    patientRef,
    authorizingPrescription,
    drugName,
    rxNormCode,
    packer,
    courier,
    eta,
    whenPrepared: resource.whenPrepared || null,
    whenHandedOver: resource.whenHandedOver || null,
    notes,
    raw: resource
  };
}

/**
 * Fetch and parse MedicationDispense by ID in a single step
 * @param {string} id - MedicationDispense resource ID
 * @returns {Promise<Object>} Standardized dispense object
 */
async function getDispenseById(id) {
  const resource = await fetchMedicationDispense(id);
  return parseMedicationDispense(resource);
}

/**
 * Record a dispense event and verify by reading it back from the FHIR server
 * @param {Object} options - Dispense configuration options or raw resource
 * @returns {Promise<Object>} Confirmed, parsed MedicationDispense record
 */
async function recordDispenseAndDispatch(options) {
  const resource = options.resourceType === 'MedicationDispense'
    ? options
    : buildMedicationDispense(options);

  const created = await createMedicationDispense(resource);
  if (!created || !created.id) {
    throw new Error('Failed to confirm MedicationDispense creation: No ID returned by FHIR server');
  }

  // Confirm write succeeded by reading it back from the FHIR server
  const verifiedRecord = await getDispenseById(created.id);
  return verifiedRecord;
}

module.exports = {
  ETA_EXTENSION_URL,
  DISPENSE_PERFORMER_SYSTEM,
  buildMedicationDispense,
  createMedicationDispense,
  fetchMedicationDispense,
  parseMedicationDispense,
  getDispenseById,
  recordDispenseAndDispatch
};
