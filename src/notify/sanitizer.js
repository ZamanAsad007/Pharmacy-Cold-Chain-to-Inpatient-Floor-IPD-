/**
 * PHI Stripping and Nurse Notification Module (Phase 5)
 * 
 * Implements strict data minimization and HIPAA Safe Harbor de-identification.
 * Only non-identifying operational logistics (courier, ETA, cold-chain category)
 * are included in outbound push alerts to ward mobile devices.
 */

const BLOCKED_PHI_FIELDS = [
  'patient',
  'patientName',
  'patientRef',
  'subject',
  'mrn',
  'birthDate',
  'dob',
  'gender',
  'room',
  'roomNumber',
  'bed',
  'bedNumber',
  'address',
  'phone',
  'telecom',
  'ssn',
  'diagnosis'
];

/**
 * Determine safe high-level medication category without exposing sensitive drug formulations
 * @param {string} drugName - Brand or generic medication name
 * @returns {string} Safe generalized clinical category
 */
function deriveMedicationCategory(drugName = '') {
  const lower = drugName.toLowerCase();
  if (lower.includes('insulin') || lower.includes('glargine') || lower.includes('lispro')) {
    return 'Refrigerated Biologic / Insulin';
  }
  if (lower.includes('vaccine') || lower.includes('toxoid')) {
    return 'Refrigerated Biologic / Vaccine';
  }
  if (lower.includes('antibiotic') || lower.includes('amoxicillin') || lower.includes('cef')) {
    return 'Inpatient Antibiotic';
  }
  if (lower.includes('chemo') || lower.includes('cisplatin') || lower.includes('doxorubicin')) {
    return 'Specialty Oncology (Refrigerated)';
  }
  return 'Temperature-Controlled Inpatient Medication';
}

/**
 * Sanitize a full MedicationDispense record or prescription into a zero-PHI payload
 * @param {Object} dispenseRecord - Full MedicationDispense resource or parsed record containing PHI
 * @param {Object} [options] - Additional delivery options (e.g. wardUnit, destinationStation)
 * @returns {Object} Strictly whitelisted, de-identified nurse notification payload
 */
function sanitizeForNurseNotification(dispenseRecord = {}, options = {}) {
  if (!dispenseRecord || typeof dispenseRecord !== 'object') {
    throw new Error('Dispense record is required for nurse notification');
  }

  // 1. Extract dispense ID (opaque reference)
  const dispenseId = dispenseRecord.id || 'DISP-UNKNOWN';

  // 2. Extract Courier Name (safe logistic detail)
  let courierName = 'Designated Pharmacy Courier';
  if (dispenseRecord.courier && typeof dispenseRecord.courier === 'object') {
    courierName = dispenseRecord.courier.name || courierName;
  } else if (typeof dispenseRecord.courier === 'string') {
    courierName = dispenseRecord.courier;
  } else if (Array.isArray(dispenseRecord.performer)) {
    const courierPerformer = dispenseRecord.performer.find(p => {
      const coding = p.function?.coding || [];
      return coding.some(c => c.code === 'courier' || c.code === 'deliverer') ||
        (p.function?.text && /courier/i.test(p.function.text));
    });
    if (courierPerformer?.actor?.display) {
      courierName = courierPerformer.actor.display;
    }
  }

  // 3. Extract ETA (safe timing detail)
  let eta = null;
  if (dispenseRecord.eta) {
    eta = dispenseRecord.eta;
  } else if (Array.isArray(dispenseRecord.extension)) {
    const etaExt = dispenseRecord.extension.find(ext =>
      ext.url && (ext.url.includes('expected-delivery-time') || ext.url.includes('eta'))
    );
    if (etaExt) {
      eta = etaExt.valueDateTime || etaExt.valueString || null;
    }
  }

  if (!eta && options.eta) {
    eta = options.eta;
  }

  // 4. Derive safe medication category (NO raw patient-tied specifics)
  const rawDrug = dispenseRecord.drugName ||
    dispenseRecord.medicationCodeableConcept?.text ||
    dispenseRecord.medicationCodeableConcept?.coding?.[0]?.display ||
    'Temperature-Controlled Medication';
  const category = deriveMedicationCategory(rawDrug);

  // 5. Cold chain handling requirements
  const storageCondition = options.storageCondition || 'Maintain 2-8°C (Cold Chain Refrigerated)';

  // 6. Generic floor destination (Station-level only, strictly NO room or bed numbers)
  const destinationStation = options.destinationStation || 'Inpatient Floor Nursing Station';

  // Construct pure whitelisted payload
  const notificationPayload = {
    notificationId: `NOTIF-${Date.now()}-${Math.floor(Math.random() * 1000)}`,
    dispenseId: String(dispenseId),
    alertType: 'COLD_CHAIN_DELIVERY_DISPATCHED',
    status: 'in-transit',
    medicationCategory: category,
    storageCondition,
    destinationStation,
    courier: courierName,
    estimatedArrival: eta || new Date(Date.now() + 15 * 60 * 1000).toISOString(),
    requiresImmediateRefrigeration: true,
    dispatchedAt: dispenseRecord.whenHandedOver || new Date().toISOString()
  };

  return notificationPayload;
}

/**
 * Validate that an object contains zero PHI fields or patient references
 * @param {Object} payload - Object to verify
 * @returns {boolean} True if clean, throws error if PHI detected
 */
function verifyZeroPhi(payload) {
  if (!payload || typeof payload !== 'object') {
    return true;
  }

  const keys = Object.keys(payload);
  for (const key of keys) {
    const lowerKey = key.toLowerCase();
    for (const blocked of BLOCKED_PHI_FIELDS) {
      if (lowerKey === blocked.toLowerCase()) {
        throw new Error(`PHI Leakage Detected! Blocked key '${key}' found in notification payload`);
      }
    }

    // Check nested objects
    if (typeof payload[key] === 'object' && payload[key] !== null) {
      verifyZeroPhi(payload[key]);
    }
  }

  // Check serialized values for typical PHI patterns like "Patient/" references
  const serialized = JSON.stringify(payload);
  if (/Patient\/\d+/i.test(serialized) || /"subject"\s*:/i.test(serialized)) {
    throw new Error('PHI Leakage Detected! Patient reference found in serialized payload');
  }

  return true;
}

// In-memory mock notification store for audit & verification
const notificationLog = [];

/**
 * Mock function to dispatch a sanitized notification to the floor nurse station
 * @param {Object} payload - De-identified notification payload
 * @param {Object} [channelOptions] - Delivery options (e.g. channel: 'push', stationId: 'WARD-3')
 * @returns {Promise<Object>} Delivery confirmation receipt
 */
async function sendNurseNotification(payload, channelOptions = {}) {
  // Ensure payload is safe before dispatch
  verifyZeroPhi(payload);

  const receipt = {
    success: true,
    receiptId: `RCP-${Date.now()}`,
    channel: channelOptions.channel || 'APNs/FCM Mock Gateway',
    targetStation: payload.destinationStation || 'Inpatient Floor Nursing Station',
    sentAt: new Date().toISOString(),
    notification: payload
  };

  notificationLog.push(receipt);
  return receipt;
}

/**
 * Retrieve recent notification history
 */
function getNotificationHistory() {
  return [...notificationLog];
}

/**
 * Clear notification history (useful in tests)
 */
function clearNotificationHistory() {
  notificationLog.length = 0;
}

module.exports = {
  BLOCKED_PHI_FIELDS,
  deriveMedicationCategory,
  sanitizeForNurseNotification,
  verifyZeroPhi,
  sendNurseNotification,
  getNotificationHistory,
  clearNotificationHistory
};
