interface Env extends CloudflareBindings {
  GOOGLE_CLIENT_ID: string;
  GOOGLE_CLIENT_SECRET: string;
  PAYPAL_CLIENT_ID: string;
  PAYPAL_CLIENT_SECRET: string;
  PAYPAL_MERCHANT_ID: string;
  PAYPAL_WEBHOOK_ID: string;
  CHANNEL3_API_KEY: string;
  NIMIQ_RPC_URL?: string;
  NIMIQ_NETWORK?: string;
}
