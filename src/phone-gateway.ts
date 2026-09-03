export {
  PHONE_CORE_ROUTES,
  PHONE_ERROR_CODES,
  PHONE_GATEWAY_PORT,
  PHONE_GATEWAY_TARGET,
  PHONE_GATEWAY_LIMITS,
  PHONE_PUBLIC_HTTPS_PORT,
  PHONE_SERVE_HTTPS_FLAG,
  PhoneGatewayError,
  type PhoneErrorCode,
  type PhoneGatewayConfig,
  type PhoneRouteMatch,
  type PhoneServeSpec,
} from "./phone-gateway-protocol.js";
export {
  authenticateTailnetOwner,
  isTrustedServeRequest,
  parsePhoneGatewayConfig,
  parsePhoneServeSpec,
} from "./phone-gateway-config.js";
export { matchPhoneRoute } from "./phone-gateway-routes.js";
export { createPhoneRateLimiter } from "./phone-gateway-adapter.js";
export { writePhoneGatewayError } from "./phone-gateway-http.js";
export { createPhoneGatewayServer, type PhoneGatewayServer } from "./phone-gateway-server.js";
