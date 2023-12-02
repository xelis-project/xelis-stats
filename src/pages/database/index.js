import useQueryString from 'g45-react/hooks/useQueryString'

import DisplayList from './display_list'
import ViewStats from './view_stats'
import { useEffect } from 'react'

function Index() {
  const [query, _] = useQueryString()

  useEffect(() => {
    // scroll top if coming from another page (ex: dashboard)
    document.body.scrollTop = 0
  }, [])

  return <div>
    {!query.data_source && <DisplayList />}
    {query.data_source && <ViewStats />}
  </div>
}

export default Index
