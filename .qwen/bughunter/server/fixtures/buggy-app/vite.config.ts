import react from '@vitejs/plugin-react';
import { defineConfig, type Plugin } from 'vite';

type Order = {
  id: number;
  amount: number;
};

const orders: Order[] = [
  { id: 1, amount: 10 },
  { id: 2, amount: 15 },
];

function ordersApi(): Plugin {
  return {
    name: 'orders-api',
    configureServer(server) {
      server.middlewares.use('/api/orders', (req, res) => {
        res.setHeader('Content-Type', 'application/json');

        if (req.method === 'GET') {
          res.statusCode = 200;
          res.end(JSON.stringify(orders));
          return;
        }

        if (req.method === 'POST') {
          let body = '';
          req.on('data', (chunk) => {
            body += chunk;
          });
          req.on('end', () => {
            let quantity: number;
            try {
              quantity = (JSON.parse(body) as { quantity: number }).quantity;
            } catch {
              res.statusCode = 400;
              res.end(JSON.stringify({ error: 'Invalid JSON' }));
              return;
            }

            if (quantity === 0) {
              res.statusCode = 500;
              res.end(JSON.stringify({ error: 'Quantity cannot be zero' }));
              return;
            }

            const order = { id: orders.length + 1, amount: quantity * 10 };
            orders.push(order);
            res.statusCode = 201;
            res.end(JSON.stringify(order));
          });
          return;
        }

        res.statusCode = 405;
        res.end(JSON.stringify({ error: 'Method not allowed' }));
      });
    },
  };
}

export default defineConfig({
  plugins: [react(), ordersApi()],
});
