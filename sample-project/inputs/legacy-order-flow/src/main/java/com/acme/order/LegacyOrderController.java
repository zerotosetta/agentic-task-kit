package com.acme.order;

import java.util.LinkedHashMap;
import java.util.Map;

public class LegacyOrderController {
  private final Map<String, String> orderStatus = new LinkedHashMap<>();

  public String placeOrder(String customerId, int quantity) {
    if (customerId == null || customerId.isBlank()) {
      return "INVALID_CUSTOMER";
    }
    if (quantity <= 0) {
      return "INVALID_QUANTITY";
    }

    String key = customerId + ":" + quantity;
    orderStatus.put(key, "PLACED");
    return "PLACED";
  }

  public String lookupStatus(String customerId, int quantity) {
    String key = customerId + ":" + quantity;
    return orderStatus.get(key);
  }
}
