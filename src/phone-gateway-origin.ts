import { headerValues } from "./phone-gateway-config.js";

export function readPhoneOrigin(rawHeaders: readonly string[]):
  | { readonly kind: "absent" }
  | { readonly kind: "ok"; readonly value: string }
  | { readonly kind: "bad" } {
  const values = headerValues(rawHeaders, "origin");
  if (values.length === 0) return { kind: "absent" };
  if (values.length !== 1 || values[0] === undefined || values[0] === "null") return { kind: "bad" };
  return { kind: "ok", value: values[0] };
}
