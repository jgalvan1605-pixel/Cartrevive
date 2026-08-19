export interface ShopifyCheckoutItem {
  title: string;
  quantity: number;
  price: string;
}

export interface ShopifyCustomer {
  first_name: string;
  last_name: string;
  email: string;
  phone: string | null;
}

export interface ShopifyCheckoutEvent {
  id: number;
  token: string;
  email: string | null;
  total_price: string;
  currency: string;
  line_items: ShopifyCheckoutItem[];
  customer?: ShopifyCustomer;
  abandoned_checkout_url: string;
}
