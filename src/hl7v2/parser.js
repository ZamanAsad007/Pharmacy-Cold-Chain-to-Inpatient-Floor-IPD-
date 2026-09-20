const hl7 = require('simple-hl7');

/**
 * Standard HL7 parser instance from simple-hl7
 */
const parser = new hl7.Parser();

/**
 * Safe helper to extract string component from segment
 * @param {Object} segment - HL7 segment
 * @param {number} fieldIdx - Field index (1-based)
 * @param {number} compIdx - Component index (1-based)
 * @returns {string}
 */
function getComponentSafe(segment, fieldIdx, compIdx = 1) {
  if (!segment) return '';
  try {
    const val = segment.getComponent(fieldIdx, compIdx);
    return val !== undefined && val !== null ? String(val).trim() : '';
  } catch {
    return '';
  }
}

/**
 * Safe helper to extract entire field from segment
 * @param {Object} segment - HL7 segment
 * @param {number} fieldIdx - Field index (1-based)
 * @returns {string}
 */
function getFieldSafe(segment, fieldIdx) {
  if (!segment) return '';
  try {
    const val = segment.getField(fieldIdx);
    return val !== undefined && val !== null ? String(val).trim() : '';
  } catch {
    return '';
  }
}

/**
 * Parse an HL7 v2 OMP^O09 Pharmacy Order message into a clean, structured object
 * @param {string} rawHl7 - Raw HL7 v2 pipe-delimited message string
 * @returns {Object} Structured message object
 */
function parseOmpO09(rawHl7) {
  if (!rawHl7 || typeof rawHl7 !== 'string' || rawHl7.trim().length === 0) {
    return {
      success: false,
      error: 'Empty or invalid HL7 message input',
      data: null
    };
  }

  const cleanRaw = rawHl7.trim();

  // Validate MSH header existence
  if (!cleanRaw.startsWith('MSH')) {
    return {
      success: false,
      error: 'Malformed HL7 message: Missing MSH segment header',
      data: null
    };
  }

  try {
    // HL7 standard defines segment terminator as carriage return \r
    const normalizedHl7 = cleanRaw.replace(/\r?\n/g, '\r');
    const msg = parser.parse(normalizedHl7);

    if (!msg || !msg.header) {
      return {
        success: false,
        error: 'Failed to parse message header with HL7 parser',
        data: null
      };
    }

    const msh = msg.header;
    const messageType = getFieldSafe(msh, 7); // e.g. OMP^O09

    // Extract Header Details
    const messageHeader = {
      messageType: messageType || getComponentSafe(msh, 7, 1),
      triggerEvent: getComponentSafe(msh, 7, 2),
      messageControlId: getFieldSafe(msh, 8),
      sendingApp: getFieldSafe(msh, 1),
      sendingFacility: getFieldSafe(msh, 2),
      receivingApp: getFieldSafe(msh, 3),
      receivingFacility: getFieldSafe(msh, 4),
      timestamp: getFieldSafe(msh, 5),
      processingId: getFieldSafe(msh, 9),
      versionId: getFieldSafe(msh, 10)
    };

    // Extract PID Segment
    const pid = msg.getSegment('PID');
    let patient = null;
    if (pid) {
      const idRaw = getComponentSafe(pid, 3, 1);
      const familyName = getComponentSafe(pid, 5, 1);
      const givenName = getComponentSafe(pid, 5, 2);
      const middleName = getComponentSafe(pid, 5, 3);
      const fullName = [givenName, middleName, familyName].filter(Boolean).join(' ');

      patient = {
        patientId: idRaw,
        familyName,
        givenName,
        middleName,
        fullName: fullName || 'Unknown Patient',
        birthDate: getFieldSafe(pid, 7),
        gender: getFieldSafe(pid, 8)
      };
    }

    // Extract ORC (Common Order) Segment
    const orc = msg.getSegment('ORC');
    let order = null;
    if (orc) {
      order = {
        orderControl: getFieldSafe(orc, 1),
        placerOrderNumber: getComponentSafe(orc, 2, 1) || getFieldSafe(orc, 2),
        orderStatus: getFieldSafe(orc, 5),
        orderDateTime: getFieldSafe(orc, 9)
      };
    }

    // Extract RXO (Pharmacy Order) Segment
    const rxo = msg.getSegment('RXO');
    let medication = null;
    if (rxo) {
      const drugCode = getComponentSafe(rxo, 1, 1);
      const drugName = getComponentSafe(rxo, 1, 2);
      const codingSystem = getComponentSafe(rxo, 1, 3);
      const giveAmount = getFieldSafe(rxo, 2);
      const giveUnits = getFieldSafe(rxo, 4);
      const specialHandling = getFieldSafe(rxo, 9);

      // Check cold-chain handling requirements
      const upperHandling = specialHandling.toUpperCase();
      const isColdChain = upperHandling.includes('REFRIGERATE') ||
                          upperHandling.includes('COLD') ||
                          upperHandling.includes('CHILLED') ||
                          upperHandling.includes('2-8');

      medication = {
        code: drugCode,
        name: drugName,
        codingSystem,
        giveAmount,
        giveUnits,
        specialHandling,
        isColdChain
      };
    }

    return {
      success: true,
      error: null,
      data: {
        raw: cleanRaw,
        messageHeader,
        patient,
        order,
        medication
      }
    };
  } catch (error) {
    return {
      success: false,
      error: `HL7 parsing exception: ${error.message}`,
      data: null
    };
  }
}

module.exports = {
  parser,
  parseOmpO09
};
