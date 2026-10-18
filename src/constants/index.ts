// RBAC Roles
export const ROLES = {
  SELLER_ADMIN: 'seller_admin',
  SELLER_ASSISTANT: 'seller_assistant',
  BUYER_ADMIN: 'buyer_admin',
  BUYER_ASSISTANT: 'buyer_assistant',
} as const;

export type Role = (typeof ROLES)[keyof typeof ROLES];

// Seller roles (can manage distributor account)
export const SELLER_ROLES = [ROLES.SELLER_ADMIN, ROLES.SELLER_ASSISTANT] as const;

// Buyer roles (can browse catalogs and place orders)
export const BUYER_ROLES = [ROLES.BUYER_ADMIN, ROLES.BUYER_ASSISTANT] as const;

// Admin-only roles
export const ADMIN_ROLES = [ROLES.SELLER_ADMIN, ROLES.BUYER_ADMIN] as const;

// Feature Flags (PostHog)
export const FEATURE_FLAGS = {
  TENANT_ONBOARDING: 'df_tenant_onboarding',
  BRAND_PRODUCT_MASTER: 'df_brand_product_master',
  CUSTOMER_MASTER: 'df_customer_master',
  COHORTS: 'df_cohorts',
  PRICING_ENGINE: 'df_pricing_engine',
  CATALOG_PUBLISHING: 'df_catalog_publishing',
  BUYER_APP: 'df_buyer_app',
  ORDER_MANAGEMENT: 'df_order_management',
  SALES_ORDERS: 'df_sales_orders',
  INVOICES: 'df_invoices',
  ESTIMATES: 'df_estimates',
  SEARCH: 'df_search',
  TALLY_EXPORT: 'df_tally_export',
  INTEGRATIONS: 'df_integrations',
  ZOHO_INTEGRATION: 'df_zoho_integration',
  TALLY_INTEGRATION: 'df_tally_integration',
  BUSY_INTEGRATION: 'df_busy_integration',
  WHATSAPP_INTEGRATION: 'df_whatsapp_integration',
  WHATSAPP_BROADCAST: 'df_whatsapp_broadcast',
  WHATSAPP_INBOX: 'df_whatsapp_inbox',
  // Phase 2 (default off)
  AI_INTAKE: 'df_ai_intake',
  REPLENISHMENT: 'df_replenishment',
  PAYMENTS: 'df_payments',
  LENDING: 'df_lending',
} as const;

// Order statuses
export const ORDER_STATUSES = {
  DRAFT: 'draft',
  RECEIVED: 'received',
  CONFIRMED: 'confirmed',
  PARTIALLY_DISPATCHED: 'partially_dispatched',
  DISPATCHED: 'dispatched',
  DELIVERED: 'delivered',
  INVOICED: 'invoiced',
  PARTIALLY_INVOICED: 'partially_invoiced',
  CANCELLED: 'cancelled',
} as const;

export type OrderStatus = (typeof ORDER_STATUSES)[keyof typeof ORDER_STATUSES];

// Buyer tiers
export const BUYER_TIERS = {
  A: 'A',
  B: 'B',
  C: 'C',
} as const;

// Plan tiers
export const PLAN_TIERS = {
  STARTER: 'starter',
  GROWTH: 'growth',
  SCALE: 'scale',
} as const;

// Units of measure (common in India)
export const UNITS_OF_MEASURE = [
  { value: 'pcs', label: 'Pieces' },
  { value: 'kg', label: 'Kilogram' },
  { value: 'ltr', label: 'Liter' },
  { value: 'box', label: 'Box' },
  { value: 'ctn', label: 'Carton' },
  { value: 'pkt', label: 'Packet' },
  { value: 'jar', label: 'Jar' },
  { value: 'bottle', label: 'Bottle' },
  { value: 'roll', label: 'Roll' },
  { value: 'sheet', label: 'Sheet' },
] as const;

// Indian states
export const INDIAN_STATES = [
  'Andaman and Nicobar Islands',
  'Andhra Pradesh',
  'Arunachal Pradesh',
  'Assam',
  'Bihar',
  'Chandigarh',
  'Chhattisgarh',
  'Dadra and Nagar Haveli',
  'Daman and Diu',
  'Delhi',
  'Goa',
  'Gujarat',
  'Haryana',
  'Himachal Pradesh',
  'Jharkhand',
  'Karnataka',
  'Kerala',
  'Ladakh',
  'Lakshadweep',
  'Madhya Pradesh',
  'Maharashtra',
  'Manipur',
  'Meghalaya',
  'Mizoram',
  'Nagaland',
  'Odisha',
  'Puducherry',
  'Punjab',
  'Rajasthan',
  'Sikkim',
  'Tamil Nadu',
  'Telangana',
  'Tripura',
  'Uttar Pradesh',
  'Uttarakhand',
  'West Bengal',
] as const;
