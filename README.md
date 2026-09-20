# Pharmacy Cold Chain to Inpatient Floor (IPD)

A FHIR-compliant, HL7-integrated healthcare interoperability solution for managing pharmacy cold chain drug distribution from central pharmacy to inpatient floor nurses.

## Overview

This project implements a secure, standards-compliant pipeline for handling temperature-sensitive medication orders. It integrates FHIR R4 resources (`MedicationRequest`, `MedicationDispense`, `AuditEvent`), validates drug identities against the NLM RxNorm/RxNav API, parses legacy HL7 v2 messages (`OMP^O09`), strips Protected Health Information (PHI) for nurse notifications, and logs tamper-evident audit trails.

## Features & Capabilities

- **FHIR R4 Server Integration**: Interact with HAPI FHIR JPA server for patient records, medication requests, and dispense operations.
- **RxNorm Drug Validation**: Verify drug codes and names using standard NLM RxNav APIs (eliminating risky string-matching).
- **Legacy HL7 v2 Parsing**: Parse `OMP^O09` pharmacy order messages using specialized parsing libraries.
- **PHI Minimization & Sanitized Alerts**: Strip sensitive patient identifiers before dispatching real-time notifications to floor nurses.
- **FHIR AuditEvent Logging**: Record all sensitive reads, writes, and alerts as standard FHIR `AuditEvent` logs.
- **Express.js API Backend**: RESTful backend services for orchestration and data processing.
- **React.js Web Interface**: Clean frontend for tracking active dispenses, logs, and nurse notifications.

---

## Directory Structure

```text
/
├── docker-compose.yml       # HAPI FHIR server container definition
├── package.json             # Backend and project dependency configuration
├── README.md                # Project documentation
├── DECISIONS.md             # Architectural decision record & trade-off log
├── src/                     # Backend Express application source
│   ├── index.js             # Express app entry point
│   ├── fhir/                # FHIR client & resource builders
│   ├── rxnorm/              # RxNav/RxNorm validation service
│   ├── hl7v2/               # Legacy HL7 message parser
│   ├── notify/              # PHI stripping & alert generator
│   └── audit/               # AuditEvent generator & logger
├── tests/                   # Automated unit and integration test suite
└── sample-data/             # Sample FHIR resources & HL7 v2 messages
```

---

## Prerequisites

- **Node.js**: v18.x or higher
- **npm**: v9.x or higher
- **Docker** or **Podman**: For running local HAPI FHIR JPA server container

---

## Quick Start & Setup

### 1. Start Local FHIR Server

Using Docker:
```bash
docker run -d --name hapi-fhir -p 8088:8080 hapiproject/hapi:v6.10.0
```

Or using Podman:
```bash
podman run -d --name hapi-fhir -p 8088:8080 docker.io/hapiproject/hapi:v6.10.0
```

Verify server availability:
```bash
curl http://localhost:8088/fhir/metadata
```

### 2. Install Project Dependencies

```bash
npm install
```

### 3. Environment Configuration

Copy `.env.example` to `.env` (or configure default environment variables):
```env
PORT=3000
FHIR_BASE_URL=http://localhost:8080/fhir
RXNAV_BASE_URL=https://rxnav.nlm.nih.gov/REST
```

### 4. Run Development Server

```bash
npm start
```

### 5. Run Test Suite

```bash
npm test
```

---

## Testing Local FHIR Server (Phase 0 Verification)

Create a sample `Patient` resource:
```bash
curl -X POST "http://localhost:8088/fhir/Patient" \
  -H "Content-Type: application/fhir+json" \
  -d '{
    "resourceType": "Patient",
    "name": [{"family": "Smith", "given": ["John"]}],
    "gender": "male",
    "birthDate": "1980-01-01"
  }'
```

Fetch the created patient by ID (replace `{id}` with ID from HTTP response):
```bash
curl -X GET "http://localhost:8088/fhir/Patient/{id}" \
  -H "Accept: application/fhir+json"
```

---

## Implementation Roadmap

- [x] **Phase 0**: Environment Setup (HAPI FHIR, folder structure, Express/React dependencies)
- [ ] **Phase 1**: Read Prescription (`MedicationRequest`)
- [ ] **Phase 2**: Validate Drug via RxNorm API
- [ ] **Phase 3**: Parse HL7 v2 `OMP^O09` Message
- [ ] **Phase 4**: Write `MedicationDispense` to FHIR Server
- [ ] **Phase 5**: PHI Stripping & Nurse Notification Payload
- [ ] **Phase 6**: AuditEvent Logging
- [ ] **Phase 7**: End-to-End Flow Integration
- [ ] **Phase 8**: SMART on FHIR PKCE Login (Stretch)
- [ ] **Phase 9**: Final Documentation & Verification
