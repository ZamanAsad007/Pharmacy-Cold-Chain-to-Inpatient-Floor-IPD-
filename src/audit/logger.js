const { fhirClient } = require('../fhir/client');

const AUDIT_EVENT_TYPE_SYSTEM = 'http://terminology.hl7.org/CodeSystem/audit-event-type';
const RESTFUL_INTERACTION_SYSTEM = 'http://hl7.org/fhir/restful-interaction';
const AUDIT_ENTITY_TYPE_SYSTEM = 'http://terminology.hl7.org/CodeSystem/audit-entity-type';

/**
 * Construct a compliant FHIR R4 AuditEvent resource
 * @param {Object} params
 * @param {string} [params.action='E'] - FHIR Action: 'C' (Create), 'R' (Read), 'U' (Update), 'D' (Delete), 'E' (Execute)
 * @param {string} [params.subtype='custom-action'] - Action subtype name
 * @param {string} [params.outcome='0'] - Outcome: '0' (Success), '4' (Minor fail), '8' (Serious fail)
 * @param {string} [params.outcomeDesc] - Description of outcome or error message
 * @param {string|Object} [params.entity] - Touched resource reference or description
 * @param {string|Object} [params.agent] - User, system, or practitioner performing the action
 * @param {string} [params.recorded] - ISO timestamp
 * @returns {Object} Valid FHIR R4 AuditEvent resource
 */
function buildAuditEvent(params = {}) {
  const action = params.action || 'E';
  const outcome = String(params.outcome ?? '0');
  const subtype = params.subtype || 'cold-chain-operation';
  const recorded = params.recorded || new Date().toISOString();

  // Agent (who/what performed the action)
  const agentDisplay = typeof params.agent === 'string'
    ? params.agent
    : params.agent?.name || params.agent?.display || 'Pharmacy Cold Chain Service';

  const agentRef = params.agent?.reference || null;

  const agent = {
    who: {
      display: agentDisplay,
      ...(agentRef ? { reference: agentRef } : {})
    },
    requestor: true
  };

  // Entity (what resource was touched)
  const entities = [];
  if (params.entity) {
    if (typeof params.entity === 'string') {
      const isRef = params.entity.includes('/');
      entities.push({
        what: isRef
          ? { reference: params.entity, display: params.entity }
          : { display: params.entity },
        description: params.entity,
        type: {
          system: AUDIT_ENTITY_TYPE_SYSTEM,
          code: '2',
          display: 'System Object'
        }
      });
    } else if (typeof params.entity === 'object') {
      const hasRef = Boolean(params.entity.reference);
      entities.push({
        what: hasRef
          ? { reference: params.entity.reference, display: params.entity.display || params.entity.reference }
          : { display: params.entity.display || params.entity.description || 'Target resource' },
        description: params.entity.description || 'Target resource',
        type: {
          system: AUDIT_ENTITY_TYPE_SYSTEM,
          code: '2',
          display: 'System Object'
        }
      });
    }
  }

  const auditResource = {
    resourceType: 'AuditEvent',
    type: {
      system: AUDIT_EVENT_TYPE_SYSTEM,
      code: 'rest',
      display: 'RESTful Operation'
    },
    subtype: [
      {
        system: RESTFUL_INTERACTION_SYSTEM,
        code: subtype,
        display: subtype
      }
    ],
    action,
    recorded,
    outcome,
    outcomeDesc: params.outcomeDesc || (outcome === '0' ? 'Operation succeeded' : 'Operation failed'),
    agent: [agent],
    source: {
      observer: {
        display: 'Pharmacy Cold Chain Gateway'
      }
    }
  };

  if (entities.length > 0) {
    auditResource.entity = entities;
  }

  return auditResource;
}

/**
 * POST a constructed AuditEvent to the FHIR server with graceful fallback for unreferenced entities
 * @param {Object} auditResource - FHIR AuditEvent resource
 * @returns {Promise<Object>} Created raw FHIR AuditEvent resource
 */
async function postAuditEvent(auditResource) {
  try {
    const response = await fhirClient.post('/AuditEvent', auditResource);
    return response.data;
  } catch (error) {
    const detail = error.response?.data?.issue?.[0]?.diagnostics || error.message;

    // If server rejects due to entity reference not existing in DB (e.g. failed attempt or mock ID),
    // convert reference to display and retry to guarantee tamper-evident audit logging
    if (detail.includes('AuditEvent.entity.what') && auditResource.entity) {
      try {
        const fallbackResource = JSON.parse(JSON.stringify(auditResource));
        for (const ent of fallbackResource.entity) {
          if (ent.what && ent.what.reference) {
            ent.what.display = ent.what.reference;
            delete ent.what.reference;
          }
        }
        const retryResponse = await fhirClient.post('/AuditEvent', fallbackResource);
        return retryResponse.data;
      } catch (retryErr) {
        throw new Error(`Failed to log AuditEvent to FHIR server: ${retryErr.message}`);
      }
    }

    throw new Error(`Failed to log AuditEvent to FHIR server: ${detail}`);
  }
}

/**
 * Build and POST an AuditEvent in a single step
 * @param {Object} params - AuditEvent parameters
 * @returns {Promise<Object>} Created raw AuditEvent resource
 */
async function logAuditEvent(params = {}) {
  const resource = buildAuditEvent(params);
  return postAuditEvent(resource);
}

/**
 * Higher-order interceptor wrapper for automated audit logging around sensitive actions.
 * Logs success ('0') on completion and failure ('4') if an error occurs.
 * 
 * @param {string} actionName - Name of the action (e.g. 'read-prescription', 'write-dispense')
 * @param {Function} fn - Async or sync function to execute and audit
 * @param {Object} [options]
 * @param {string} [options.action='E'] - 'C', 'R', 'U', 'D', 'E'
 * @param {Function} [options.getEntityRef] - Callback extracting entity ref from fn() result
 * @param {string} [options.entityRef] - Fixed entity reference string
 * @param {string|Object} [options.agent] - Performing agent
 * @returns {Promise<*>} Result of fn()
 */
async function withAudit(actionName, fn, options = {}) {
  const action = options.action || (actionName.startsWith('read') ? 'R' : 'C');

  try {
    const result = await fn();

    let entityRef = options.entityRef;
    if (options.getEntityRef && typeof options.getEntityRef === 'function') {
      entityRef = options.getEntityRef(result) || entityRef;
    }

    // Log success asynchronously without blocking unless required
    await logAuditEvent({
      action,
      subtype: actionName,
      outcome: '0',
      outcomeDesc: options.successDesc || `${actionName} completed successfully`,
      entity: entityRef,
      agent: options.agent
    });

    return result;
  } catch (error) {
    // Log failure event to guarantee complete tamper-evident audit trail
    await logAuditEvent({
      action,
      subtype: actionName,
      outcome: '4',
      outcomeDesc: `Failed ${actionName}: ${error.message}`,
      entity: options.entityRef,
      agent: options.agent
    }).catch(err => {
      console.error(`Warning: Secondary audit log failure: ${err.message}`);
    });

    throw error;
  }
}

/**
 * Fetch all AuditEvents from the FHIR server, optionally filtering by resource reference
 * @param {Object} [filter]
 * @param {string} [filter.entity] - Target resource reference (e.g. 'MedicationDispense/12')
 * @param {number} [filter.limit=50] - Number of records to return
 * @returns {Promise<Array<Object>>} Array of AuditEvent records
 */
async function getAuditEvents(filter = {}) {
  try {
    const limit = filter.limit || 50;
    let url = `/AuditEvent?_sort=-_lastUpdated&_count=${limit}`;
    if (filter.entity && !filter.entity.includes('failed')) {
      url += `&entity=${encodeURIComponent(filter.entity)}`;
    }

    let events = [];
    try {
      const response = await fhirClient.get(url);
      const bundle = response.data;
      if (bundle && bundle.entry) {
        events = bundle.entry.map(e => e.resource);
      }
    } catch (queryErr) {
      // If entity query parameter failed on server, fallback to general fetch
      const fallbackRes = await fhirClient.get(`/AuditEvent?_sort=-_lastUpdated&_count=${limit}`);
      if (fallbackRes.data && fallbackRes.data.entry) {
        events = fallbackRes.data.entry.map(e => e.resource);
      }
    }

    if (filter.entity) {
      // Ensure all matching events (reference, display, or description) are captured
      if (events.length === 0 || !url.includes('&entity=')) {
        const generalRes = await fhirClient.get(`/AuditEvent?_sort=-_lastUpdated&_count=100`);
        const allEvents = generalRes.data?.entry ? generalRes.data.entry.map(e => e.resource) : [];
        events = allEvents.filter(e => {
          if (!e.entity || !Array.isArray(e.entity)) return false;
          return e.entity.some(ent =>
            ent.what?.reference === filter.entity ||
            ent.what?.display === filter.entity ||
            ent.description === filter.entity ||
            (ent.what?.reference && ent.what.reference.includes(filter.entity)) ||
            (ent.what?.display && ent.what.display.includes(filter.entity))
          );
        });
      }
    }

    return events;
  } catch (error) {
    throw new Error(`Failed to retrieve AuditEvents: ${error.message}`);
  }
}

/**
 * Reconstruct the chronological audit history for a specific resource
 * @param {string} resourceRef - Resource reference e.g. 'MedicationRequest/10' or 'MedicationDispense/12'
 * @returns {Promise<Array<Object>>} Chronologically ordered history
 */
async function getAuditTrailForResource(resourceRef) {
  const events = await getAuditEvents({ entity: resourceRef, limit: 100 });
  // Order chronologically by recorded timestamp
  return events.sort((a, b) => new Date(a.recorded).getTime() - new Date(b.recorded).getTime());
}

module.exports = {
  buildAuditEvent,
  postAuditEvent,
  logAuditEvent,
  withAudit,
  getAuditEvents,
  getAuditTrailForResource
};
