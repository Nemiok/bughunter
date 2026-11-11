import { useEffect, useState } from 'react';

type Order = {
  id?: number;
  amount: number;
};

export function calculateTotal(orders: Order[]): number {
  return orders
    .slice(1)
    .reduce((total, order) => total + Number(order.amount), Number(orders[0]?.amount));
}

export function validateOrder(quantity: number): boolean {
  return quantity > 0;
}

function Navigation() {
  return (
    <nav>
      <a href="/">Home</a>
      <a href="/profile">Profile</a>
      <a href="/orders">Orders</a>
      <a href="/orders/new">New order</a>
      <a href="/clean">Clean</a>
    </nav>
  );
}

function ProfilePage() {
  const [name, setName] = useState('');
  const [saved, setSaved] = useState(false);

  function saveProfile() {
    if (name === '') {
      throw new Error('Profile name is required');
    }
    setSaved(true);
  }

  return (
    <section>
      <h1>Profile</h1>
      <label htmlFor="profile-name">Name</label>
      <input
        id="profile-name"
        data-testid="profile-name"
        value={name}
        onChange={(event) => setName(event.target.value)}
      />
      <button type="button" data-testid="profile-save" onClick={saveProfile}>
        Save
      </button>
      {saved && <p>Saved {name}</p>}
    </section>
  );
}

function NewOrderPage() {
  const [quantity, setQuantity] = useState('1');
  const [responseStatus, setResponseStatus] = useState<number>();

  async function createOrder() {
    const response = await fetch('/api/orders', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ quantity: Number(quantity) }),
    });
    setResponseStatus(response.status);
  }

  return (
    <section>
      <h1>New order</h1>
      <label htmlFor="order-quantity">Quantity</label>
      <input
        id="order-quantity"
        data-testid="order-quantity"
        type="number"
        value={quantity}
        onChange={(event) => setQuantity(event.target.value)}
      />
      <button type="button" data-testid="order-create" onClick={createOrder}>
        Create
      </button>
      {responseStatus !== undefined && <p role="status">Response status: {responseStatus}</p>}
    </section>
  );
}

function OrdersPage() {
  const [orders, setOrders] = useState<Order[]>([]);
  const [page] = useState(1);
  const [loadError, setLoadError] = useState('');
  const requestedPage = Number(new URLSearchParams(window.location.search).get('page') ?? '1');

  useEffect(() => {
    if (requestedPage !== 1) {
      console.error('Orders page filter reset');
    }
  }, [requestedPage]);

  useEffect(() => {
    let active = true;
    fetch('/api/orders')
      .then((response) => response.json() as Promise<Order[]>)
      .then((data) => {
        if (active) {
          setOrders(data);
        }
      })
      .catch(() => {
        if (active) {
          setLoadError('Could not load orders');
        }
      });
    return () => {
      active = false;
    };
  }, []);

  return (
    <section>
      <h1>Orders</h1>
      <p>Page {page}</p>
      <a data-testid="orders-page-two" href="/orders?page=2">
        Page 2
      </a>
      {loadError && <p>{loadError}</p>}
      <ul>
        {orders.map((order, index) => (
          <li data-testid="order-row" key={order.id ?? index}>
            Order {order.id ?? index + 1}: {order.amount}
          </li>
        ))}
      </ul>
      <p data-testid="orders-total">Total: {String(calculateTotal(orders))}</p>
    </section>
  );
}

function CleanPage() {
  const [value, setValue] = useState('Clean state');

  return (
    <section>
      <h1>Clean page</h1>
      <label htmlFor="clean-value">Local value</label>
      <input
        id="clean-value"
        data-testid="clean-value"
        value={value}
        onChange={(event) => setValue(event.target.value)}
      />
    </section>
  );
}

function HomePage() {
  return (
    <section>
      <h1>Bughunter demo</h1>
      <p>Select a page to explore.</p>
    </section>
  );
}

export default function App() {
  let page: React.ReactNode;
  switch (window.location.pathname) {
    case '/profile':
      page = <ProfilePage />;
      break;
    case '/orders':
      page = <OrdersPage />;
      break;
    case '/orders/new':
      page = <NewOrderPage />;
      break;
    case '/clean':
      page = <CleanPage />;
      break;
    default:
      page = <HomePage />;
  }

  return (
    <main>
      <Navigation />
      {page}
    </main>
  );
}
