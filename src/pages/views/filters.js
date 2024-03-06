import { useCallback, useState, useMemo, useEffect } from 'react'
import DateTimePicker from 'react-datetime-picker'
import Dropdown from 'xelis-explorer/src/components/dropdown'
import prettyMs from 'pretty-ms'
import { css } from 'goober'
import { useLang } from 'g45-react/hooks/useLang'
import { fetchView } from '../../hooks/useFetchView'
import to from 'await-to-js'

const style = {

}

export function FilterDropdown(props) {
  const { name, query, setQuery, list, queryKey, refetch } = props
  const { t } = useLang()

  const items = useMemo(() => {
    return [{ key: ``, text: t(`All`) }, ...list]
  }, [list])

  const value = query[queryKey] || ``

  return <div>
    <div>Filter ({name})</div>
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

  const [inputPeriod, setInputPeriod] = useState(query.period)
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
    ]
  }, [])

  const setPeriod = useCallback((period) => {
    if (refetch) {
      setQuery({ ...query, period, refetch: Date.now() })
    } else {
      setQuery({ ...query, period })
    }
  }, [query, refetch])

  return <div>
    <div>Period (Time)</div>
    <Dropdown items={items} value={query.period || ``} onChange={(item) => {
      setInputPeriod(item.key)
      setPeriod(item.key)
    }} />
    <div>
      <span>Seconds: </span>
      <input type="text" value={inputPeriod}
        onChange={(e) => setInputPeriod(e.target.value)} />
      <button onClick={() => setPeriod(inputPeriod)}>
        {t(`Apply`)}
      </button>
    </div>
  </div>
}


function FilterTextInput(props) {
  const { placeholder, onApply } = props
  const [value, setValue] = useState(``)

  return <div>
    <div>Filter By ()</div>
    <div>
      <input type="text" placeholder={placeholder} value={value} onChange={(e) => setValue(e.target.value)} />
      <button onClick={onApply}>Apply</button>
    </div>
  </div>
}

export function FilterUnitPeriod(props) {
  const { query, setQuery, refetch = true } = props

  const rangeUnitList = useMemo(() => {
    return [
      { key: `1`, text: `1` },
      { key: `10`, text: `10` },
      { key: `100`, text: `100` },
      { key: `1000`, text: `1K` },
      { key: `10000`, text: `10K` },
      { key: `100000`, text: `100K` },
    ]
  }, [])

  return <div>
    <div>Period (Unit)</div>
    <Dropdown items={rangeUnitList} value={query.period || ``} onChange={(item) => {
      if (refetch) {
        setQuery({ ...query, period: item.key, refetch: Date.now() })
      } else {
        setQuery({ ...query, period: item.key })
      }
    }} />
    <input type="text" />
  </div>
}
