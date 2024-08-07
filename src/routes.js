import App from 'xelis-explorer/src/app'
import NotFound from 'xelis-explorer/src/pages/notFound'

import Dashboard from './pages/dashboard'
import Layout from './layout/layout'
import View from './pages/views/view'
import List from './pages/views/list'
import Mining from './pages/mining'
import Accounts from './pages/accounts'
import Account from './pages/account'

const routes = [
  {
    element: <App title="XELIS Stats" />,
    children: [
      {
        element: <Layout />,
        children: [
          {
            path: '/',
            element: <Dashboard />,
          },
          {
            path: '/views',
            element: <List />,
          },
          {
            path: '/views/:dataSource',
            element: <View />,
          },
          {
            path: '/mining',
            element: <Mining />
          },
          {
            path: '/accounts',
            element: <Accounts />
          },
          {
            path: '/accounts/:addr',
            element: <Account />
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
