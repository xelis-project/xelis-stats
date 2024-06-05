import { useCallback, useState, useMemo, useEffect } from 'react'
import Dropdown from 'xelis-explorer/src/components/dropdown'
import { useLang } from 'g45-react/hooks/useLang'
import { fetchView } from '../../hooks/useFetchView'
import to from 'await-to-js'

export function FilterDropdown(props) {
  const { name, query, setQuery, list, queryKey, refetch } = props
  const { t } = useLang()

  const items = useMemo(() => {
    return [{ key: ``, text: t(`All`) }, ...list]
  }, [list])

  const value = query[queryKey] || ``

  return <div>
    <div>{t(`Filter ({})`, [name])}</div>
    <Dropdown items={items} value={value} onChange={(item) => {
      if (refetch) {
        setQuery({ ...query, [queryKey]: item.key, refetch: Date.now() })
      } else {
        setQuery({ ...query, [queryKey]: item.key })
      }
    }} />
  </div>
}

export function FilterMarketExchanges(props) {
  const { query, setQuery } = props
  const [list, setList] = useState([])

  useEffect(() => {
    const load = async () => {
      const [err, data] = await to(fetchView(`get_market_exchanges()`))
      if (err) return

      const { rows } = data
      const list = rows.map((item) => ({ key: item.exchange, text: item.exchange }))
      setList(list)
    }

    load()
  }, [])

  return <FilterDropdown
    refetch query={query} setQuery={setQuery}
    name="Exchange" list={list} queryKey="exchange"
  />
}

export function FilterMarketAssets(props) {
  const { query, setQuery } = props
  const [list, setList] = useState([])

  useEffect(() => {
    const load = async () => {
      const [err, data] = await to(fetchView(`get_market_assets()`))
      if (err) return

      const { rows } = data
      const list = rows.map((item) => ({ key: item.asset, text: item.asset }))
      setList(list)
    }

    load()
  }, [])

  return <FilterDropdown
    refetch query={query} setQuery={setQuery}
    name="Asset" list={list} queryKey="asset"
  />
}

export function FilterTimePeriod(props) {
  const { query, setQuery, refetch = true } = props

  const [inputPeriod, setInputPeriod] = useState(query.period || ``)
  const { t } = useLang()

  const items = useMemo(() => {
    return [
      { key: `60`, text: t(`1 minute`) },
      { key: `900`, text: t(`15 minutes`) },
      { key: `3600`, text: t(`1 hour`) },
      { key: `14400`, text: t(`4 hours`) },
      { key: `86400`, text: t(`1 day`) },
      { key: `604800`, text: t(`1 week`) },
      { key: `2628000`, text: t(`1 month`) },
      { key: `7884000`, text: t(`3 months`) },
      { key: `15768000`, text: t(`6 months`) },
      { key: `31536000`, text: t(`1 year`) },
      { key: ``, text: t(`Custom`) }
    ]
  }, [])

  const dropdownPeriod = useMemo(() => {
    if (items.map((item) => item.key).includes(query.period)) {
      return query.period
    }

    return ``
  }, [items, query.period])

  const setPeriod = useCallback((period) => {
    if (refetch) {
      setQuery({ ...query, period, refetch: Date.now() })
    } else {
      setQuery({ ...query, period })
    }
  }, [query, refetch])

  const onDropdownChange = useCallback((item) => {
    setInputPeriod(item.key)
    setPeriod(item.key)
  }, [setPeriod])

  const applyCustom = useCallback(() => {
    setPeriod(inputPeriod)
  }, [setPeriod, inputPeriod])

  return <div>
    <div>{t(`Period (Time)`)}</div>
    <Dropdown items={items} value={dropdownPeriod} onChange={onDropdownChange} />
    <div>
      <span>{t(`Seconds:`)}</span>
      <input type="text" value={inputPeriod} onChange={(e) => setInputPeriod(e.target.value)} />
      <button onClick={applyCustom}>{t(`Apply`)} </button>
    </div>
  </div>
}

export function FilterUnitPeriod(props) {
  const { query, setQuery, refetch = true } = props

  const [inputPeriod, setInputPeriod] = useState(query.period || ``)
  const { t } = useLang()

  const items = useMemo(() => {
    return [
      { key: `1`, text: `1` },
      { key: `10`, text: `10` },
      { key: `100`, text: `100` },
      { key: `1000`, text: `1K` },
      { key: `10000`, text: `10K` },
      { key: `100000`, text: `100K` },
      { key: ``, text: `Custom` }
    ]
  }, [])

  const dropdownPeriod = useMemo(() => {
    if (items.map((item) => item.key).includes(query.period)) {
      return query.period
    }

    return ``
  }, [items, query.period])

  const setPeriod = useCallback((period) => {
    if (refetch) {
      setQuery({ ...query, period, refetch: Date.now() })
    } else {
      setQuery({ ...query, period })
    }
  }, [query, refetch])

  const onDropdownChange = useCallback((item) => {
    setInputPeriod(item.key)
    setPeriod(item.key)
  }, [setPeriod])

  const applyCustom = useCallback(() => {
    setPeriod(inputPeriod)
  }, [setPeriod, inputPeriod])

  return <div>
    <div>{t(`Period (Unit)`)}</div>
    <Dropdown items={items} value={dropdownPeriod} onChange={onDropdownChange} />
    <div>
      <span>{t(`Amount:`)}</span>
      <input type="text" value={inputPeriod} onChange={(e) => setInputPeriod(e.target.value)} />
      <button onClick={applyCustom}>{t(`Apply`)} </button>
    </div>
  </div>
}
