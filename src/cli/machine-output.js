export const MACHINE_OUTPUT_SCHEMA_VERSION = 1;

export function createMachineModeError(code, message, details = null) {
  const error = new Error(message);
  error.code = code;
  if (details != null) {
    error.machineDetails = details;
  }
  return error;
}

export function createMachineSuccess({
  sessionId,
  message,
  projectRoot,
}) {
  return {
    schemaVersion: MACHINE_OUTPUT_SCHEMA_VERSION,
    status: "completed",
    sessionId,
    result: message,
    projectRoot,
  };
}

export function createMachineError(error) {
  const code = typeof error?.code === "string" && error.code
    ? error.code
    : "WTAGENT_ERROR";
  const message = String(error?.message ?? error ?? "Unknown WTAgent error.");
  const value = {
    schemaVersion: MACHINE_OUTPUT_SCHEMA_VERSION,
    status: "error",
    error: {
      code,
      message,
    },
  };

  if (
    error?.machineDetails
    && typeof error.machineDetails === "object"
    && !Array.isArray(error.machineDetails)
  ) {
    value.error.details = error.machineDetails;
  }

  return value;
}

export function writeMachineOutput(value, {
  stream = process.stdout,
} = {}) {
  stream.write(`${JSON.stringify(value)}\n`);
}
