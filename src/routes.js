import App from './app'

import Dashboard from './pages/dashboard'
import NotFound from 'xelis-explorer/src/pages/notFound'
import Layout from './layout/layout'
import Database from './pages/database'

const routes = [
  {
    element: <App />,
    children: [
      {
        element: <Layout />,
        children: [
          {
            path: '/',
            element: <Dashboard />,
          },
          {
            path: '/database',
            element: <Database />,
          },
          {
            path: '*',
            element: <NotFound />
          }
        ]
      }
    ]
  }
]

export default routes
