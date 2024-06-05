import to from 'await-to-js'
import queryString from 'query-string'
import { useCallback, useEffect, useRef, useState } from 'react'

export async function fetchView(viewName, params) {
  const endpoint = queryString.stringifyUrl({
    url: `${INDEX_REST_ENDPOINT}/views/${viewName}`,
    query: params
  })

  const [err, res] = await to(fetch(endpoint))
  if (err) {
    return Promise.reject(err)
  }

  if (!res.ok) {
    const data = await res.text()
    return Promise.reject(data)
  }

  const data = await res.json()
  return Promise.resolve(data)
}

export function useFetchView(props) {
  const { view, params, fetchOnLoad = true } = props

  const [firstLoading, setFirstLoading] = useState(true)
  const [loading, setLoading] = useState(true)
  const firstFetch = useRef(true)
  const [err, setErr] = useState(null)
  const [rows, setRows] = useState([])
  const [count, setCount] = useState(0)

  const fetch = useCallback(async () => {
    setErr(null)
    setLoading(true)
    if (firstFetch.current) setFirstLoading(true)
    const [err, data] = await to(fetchView(view, params))
    setLoading(false)
    if (firstFetch.current) setFirstLoading(false)
    if (err) return setErr(err)

    setRows(data.rows)
    setCount(data.count)
    firstFetch.current = false
  }, [view, params])

  useEffect(() => {
    if (fetchOnLoad) fetch()
  }, [])

  return { firstLoading, loading, err, rows, count, fetch }
}
