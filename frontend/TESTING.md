# Frontend Testing

Vitest is not currently in `devDependencies`, so automated smoke tests are deferred.

## To add test infrastructure

Install the following devDependencies:

```bash
npm install --save-dev vitest @testing-library/react @testing-library/user-event jsdom
```

Then add a `test` script to `package.json`:

```json
"scripts": {
  "test": "vitest run",
  "test:watch": "vitest"
}
```

And add vitest config to `vite.config.ts`:

```ts
test: {
  environment: 'jsdom',
  globals: true,
  setupFiles: './src/test-setup.ts',
},
```

## Example smoke test

Once installed, place tests in `src/__tests__/`:

```ts
// src/__tests__/App.smoke.test.tsx
import { render, screen } from '@testing-library/react'
import App from '../App'

test('renders without crashing', () => {
  render(<App />)
  // Adjust assertion to match a real landmark element in App
  expect(document.body).toBeTruthy()
})
```

Run with:

```bash
npx vitest run
```
