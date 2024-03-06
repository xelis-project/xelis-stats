import to from 'await-to-js'
import queryString from 'query-string'
import { useCallback, useEffect, useState } from 'react'

const host = "http://localhost:8000"

export async function fetchView(viewName, params) {
  const endpoint = queryString.stringifyUrl({
    url: `${host}/views/${viewName}`,
    query: params
  })

  const [err, res] = await to(fetch(endpoint))
  if (err) {
    return Promise.reject(err)
  }

  const data = await res.json()
  return Promise.resolve(data)
}

export function useFetchView(props) {
  const { view, params, autoLoad = true } = props

  const [loading, setLoading] = useState(autoLoad)
  const [err, setErr] = useState()
  const [rows, setRows] = useState([])
  const [count, setCount] = useState(0)

  const load = useCallback(async () => {
    setLoading(true)
    const [err, data] = await to(fetchView(view, params))
    setLoading(false)
    if (err) return setErr(err)

    setRows(data.rows)
    setCount(data.count)
  }, [view, params])

  useEffect(() => {
    if (autoLoad) load()
  }, [])

  return { loading, err, rows, count, load }
}
