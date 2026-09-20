# Architectural Decisions & Trade-Off Log (`DECISIONS.md`)

This document details the architectural choices, standards alignments, engineering trade-offs, and future improvements for the **Pharmacy Cold Chain to Inpatient Floor (IPD)** system.

---

## 1. Architectural & Standards Alignments

### 1.1 FHIR R4 Server Architecture
* **Decision**: Deploy and interact with the official **HAPI FHIR JPA Server Starter** (FHIR R4) via Docker rather than using in-memory mock endpoints.
* **Rationale**: Real hospital Electronic Health Record (EHR) systems enforce strict schema validation, structural constraints, and referential integrity (e.g. rejecting a `MedicationDispense` if its referenced `MedicationRequest` or `Patient` does not exist). Developing against an authentic FHIR server ensures real-world compatibility and eliminates false positives common in mock-based development.

### 1.2 Drug Identity Validation via RxNorm (Not String Matching)
* **Decision**: Query the National Library of Medicine (NLM) **RxNav API** to validate medications by standard **RxCUI** codes, with automatic fallback to approximate matching.
* **Rationale**: Relying on naive string matching (e.g., `name.includes(...)` or regex) is a recognized clinical interoperability anti-pattern. Brand names, generic equivalents, synonyms, and dosage formulations differ across hospital systems. Standardizing on RxNorm ensures clinical accuracy and eliminates ambiguities.

### 1.3 AST-Based HL7 v2 Message Parsing
* **Decision**: Utilize the compliant `simple-hl7` parser library to ingest legacy `OMP^O09` pharmacy order messages instead of manual string delimiters (`split('|')`).
* **Rationale**: Real-world hospital HL7 v2 messages vary widely in segment order, optional fields, multi-valued components (`~`), subcomponents (`&`), and escape characters (`\E\`). AST-based parsing ensures malformed or incomplete messages are handled gracefully without application crashes.

### 1.4 MedicationDispense & Cold Chain Logistics Modeling
* **Decision**: Model packaging and transit in FHIR R4 `MedicationDispense`:
  * **Status**: Maintained as `in-progress` while the package is with the courier.
  * **Performer Roles**: Standardized using the HL7 performer role code system (`http://terminology.hl7.org/CodeSystem/medicationdispense-performer-role`) for `packager` and `courier`.
  * **Expected Arrival Time (ETA)**: Modeled as a structured FHIR extension (`http://pharmacy-cold-chain.org/fhir/StructureDefinition/expected-delivery-time`) using `valueDateTime`.
  * **Write Confirmation**: The `recordDispenseAndDispatch()` function confirms write persistence by immediately reading the record back from the server before reporting success.

### 1.5 Strict Data Minimization & PHI Stripping (HIPAA Safe Harbor)
* **Decision**: Apply an explicit whitelist-only sanitization policy for all floor nurse notifications.
* **Rationale**: Push notifications delivered to mobile handsets in inpatient corridors must never leak Protected Health Information (PHI). The sanitizer strips all 18 HIPAA Safe Harbor identifiers (patient names, MRNs, birth dates, room and bed numbers). Only non-identifying operational logistics (courier name, ETA, generalized medication category like "Refrigerated Biologic / Insulin", and destination station) are emitted. Automated verification functions (`verifyZeroPhi`) enforce zero leakage.

### 1.6 Tamper-Evident Audit Logging (FHIR AuditEvent)
* **Decision**: Wrap all sensitive operations (prescription reads, dispense writes, nurse alerts, and pipeline failures) with an interceptor (`withAudit`) that records immutable FHIR `AuditEvent` records.
* **Rationale**: Regulatory compliance requires complete auditability. Every operation logs: who performed the action, which resource was touched, timestamp, action type (`C`, `R`, `E`), and outcome (`0` for success, `4` for failure). The system allows instant chronological reconstruction of any prescription's lifecycle.

### 1.7 SMART on FHIR OAuth 2.0 with PKCE (Zero Cleartext LocalStorage)
* **Decision**: Implement the official SMART on FHIR App Launch specification using RFC 7636 PKCE (Proof Key for Code Exchange) with ephemeral in-memory session management.
* **Rationale**: Storing access tokens or client secrets in browser `localStorage` or cleartext storage is an OWASP and healthcare security violation. The application maintains isolated in-memory sessions with automatic expiration, supporting embedded EHR launch contexts without credential exposure.

---

## 2. Engineering Trade-offs

| Decision | Chosen Approach | Alternative Considered | Rationale / Trade-off |
| :--- | :--- | :--- | :--- |
| **Referential Integrity** | Enforce real references in integration tests | Fake mock identifiers | Ensuring referential integrity requires pre-seeding `Patient` and `Practitioner` records, but guarantees tests mirror production EHR behavior. |
| **ETA Modeling** | FHIR Extension with `valueDateTime` | Custom top-level JSON fields | Top-level custom fields are rejected by standards-compliant FHIR servers. Extensions maintain 100% schema compliance. |
| **Network Resilience** | Mockable HTTP client with offline unit tests | Live external API calls in all tests | Live API calls introduce external flakiness and rate limits. Mocking RxNav in unit tests guarantees determinism while live integration tests verify real connectivity. |
| **Outbound Alerts** | In-memory simulated dispatch gateway | Live cellular push service (APNs/FCM) | Demonstrates payload safety and delivery receipts without requiring third-party cloud credentials or paid developer accounts. |

---

## 3. What We Would Do Differently with Real Hospital Access & More Time

1. **IoT Temperature Telemetry Stream**:
   * Integrate Bluetooth Low Energy (BLE) or LoRaWAN temperature data loggers inside the cooler box.
   * Stream continuous temperature readings directly into FHIR `Observation` or `DeviceMetric` resources.
   * Implement automated threshold triggers that automatically alert the nurse and pharmacy if temperatures exceed 2–8°C for >15 minutes.

2. **Native EHR Embedded SMART Launch**:
   * Register the application in real Epic App Orchard and Cerner Code sandboxes.
   * Embed the application directly as a tab inside the nurse's EHR Inpatient Flowsheet.

3. **MLLP TCP Socket Integration**:
   * Add a native MLLP (Minimal Lower Layer Protocol) TCP socket listener alongside HTTP REST to interface directly with legacy hospital interface engines (e.g., Mirth Connect, Rhapsody, or Cloverleaf).

4. **Hardware Security Module (HSM) / Vault Key Management**:
   * Protect OAuth private keys and API signing credentials using cloud secret managers (AWS Secrets Manager / GCP Secret Manager / HashiCorp Vault).

---

## 4. Known Gaps & Mitigations

* **Local Transport Encryption**: The local test container communicates over HTTP (`http://localhost:8088/fhir`). Production deployments must be fronted by an Nginx or Envoy reverse proxy with TLS 1.3 encryption.
* **Push Notification Gateway**: Outbound alerts currently route to a simulated in-memory dispatch queue. In production, this connects to an enterprise mobile device management (MDM) push gateway.
