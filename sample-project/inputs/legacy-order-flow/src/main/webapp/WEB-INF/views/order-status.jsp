<%@ page contentType="text/html; charset=UTF-8" %>
<html>
  <body>
    <h1>Order Status</h1>
    <div class="status"><%= request.getAttribute("orderStatus") %></div>
    <div class="customer"><%= request.getAttribute("customerId") %></div>
  </body>
</html>
