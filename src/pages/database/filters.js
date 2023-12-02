import { useCallback, useState, useMemo, useEffect } from 'react'
import DateTimePicker from 'react-datetime-picker'
import Dropdown from 'xelis-explorer/src/components/dropdown'
import prettyMs from 'pretty-ms'
import { css } from 'goober'

import supabase from '../../hooks/useSupabase'
import { useLang } from 'g45-react/hooks/useLang'

const style = {
  filterTime: css`
    > :nth-child(2) {
      display: flex;
      gap: .5em;
      flex-direction: column;

      > :nth-child(1) {
        display: flex;
        gap: .5em;
        
        button {
          background: none;
          border: thin solid var(--text-color);
          border-radius: 0.5em;
          color: var(--text-color);
          cursor: pointer;
          padding: 0.5em .75em;
        }
      }

      > :nth-child(2) {
        display: flex;
        gap: .5em;
        flex-direction: column;

        > :nth-child(3) {
          background: none;
          border: thin solid var(--text-color);
          border-radius: 0.5em;
          color: var(--text-color);
          cursor: pointer;
          padding: 0.5em .75em;
        }
      }
    }

    .react-datetime-picker {
      width: 100%;
    }

    .react-datetime-picker__button svg {
      stroke: var(--text-color);
    }

    .react-datetime-picker__wrapper {
      width: 100%;
      border-radius: .5em;
      padding: .25em;
      border: thin solid var(--text-color);
      background-color: #101010;
      display: flex;
      gap: .25em;
      align-items: center;
    }

    .react-datetime-picker__inputGroup {
      flex: 1;
      display: flex;
      gap: .1em;
      align-items: center;
    }

    .react-datetimerange-picker__inputGroup__input:invalid {
      background: rgb(255 255 255 / 5%);
    }

    .react-calendar {
      padding: .5em;
      background-color: #101010;
      border-radius: .5em;
    }

    .react-calendar__navigation {
      display: flex;
      gap: .5em;
      margin-bottom: .5em;

      button {
        background: none;
        border: thin solid var(--text-color);
        border-radius: 0.25em;
        color: var(--text-color);
        cursor: pointer;
        padding: 0.5em 1em;
      }
    }

    .react-calendar__month-view__weekdays {
      margin-bottom: .5em;
    }

    .react-calendar__month-view__days {

    }

    .react-calendar__tile {
      background: none;
      border: thin solid var(--text-color);
      border-radius: .25em;
      color: var(--text-color);
      padding: .25em;
      cursor: pointer;
    }
  `
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
      const { error, data } = await supabase
        .rpc(`get_market_exchanges`)
      if (error) console.log(error)

      const list = data.map((item) => ({ key: item.exchange, text: item.exchange }))
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
      const { error, data } = await supabase
        .rpc(`get_market_assets`)
      if (error) console.log(error)

      const list = data.map((item) => ({ key: item.asset, text: item.asset }))
      setList(list)
    }

    load()
  }, [])

  return <FilterDropdown
    refetch query={query} setQuery={setQuery}
    name="Asset" list={list} queryKey="asset"
  />
}

export function FilterTimeRange(props) {
  const { query, setQuery } = props

  const [fromValue, setFromValue] = useState(new Date())
  const [toValue, setToValue] = useState(new Date())

  const setRangeByDuration = useCallback((duration) => {
    const now = new Date()
    const end = Math.round(now / 1000)
    const start = end - duration
    setQuery({ ...query, start_timestamp: start, end_timestamp: end, refetch: Date.now() })
    setFromValue(new Date(start * 1000))
    setToValue(now)
  }, [query])

  const apply = useCallback(() => {
    const end = Math.round(toValue.getTime() / 1000)
    const start = Math.round(fromValue.getTime() / 1000)
    setQuery({ ...query, start_timestamp: start, end_timestamp: end, refetch: Date.now() })
  }, [fromValue, toValue])

  const duration = useMemo(() => {
    return toValue.getTime() - fromValue.getTime()
  }, [fromValue, toValue])

  return <div className={style.filterTime}>
    <div>Range (Time)</div>
    <div>
      <div>
        <button onClick={() => setRangeByDuration(3600)}>1h</button>
        <button onClick={() => setRangeByDuration(3600 * 4)}>4h</button>
        <button onClick={() => setRangeByDuration(3600 * 24)}>1d</button>
        <button onClick={() => setRangeByDuration(86400 * 7)}>1w</button>
        <button onClick={() => setRangeByDuration(2628000)}>1m</button>
        <button onClick={() => setRangeByDuration(31536000)}>1y</button>
        <button>All</button>
      </div>
      <div>
        <DateTimePicker onChange={setFromValue} value={fromValue} locale='id-ID' disableClock />
        <DateTimePicker onChange={setToValue} value={toValue} locale='id-ID' disableClock />
        <button onClick={apply}>Apply</button>
      </div>
      <div>Duration: {prettyMs(duration, { compact: true })}</div>
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

export function FilterUnitRange(props) {
  const { query, setQuery } = props

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
    <div>Range (Unit)</div>
    <Dropdown items={rangeUnitList} value={query.range} onChange={(item) => {
      setQuery({ ...query, range: item.key, refetch: Date.now() })
    }} />
    <div>Offset: <input type="number" /></div>
  </div>
}

export function FilterIntervalRange(props) {
  const { query, setQuery } = props

  const rangeIntervalList = useMemo(() => {
    return [
      { key: `second`, text: `Second` },
      { key: `minute`, text: `Minute` },
      { key: `hour`, text: `Hour` },
      { key: `day`, text: `Day` },
      { key: `week`, text: `Week` },
      { key: `month`, text: `Month` },
      { key: `year`, text: `Year` },
    ]
  }, [])

  return <div>
    <div>Range (Interval)</div>
    <Dropdown items={rangeIntervalList} value={query.range} onChange={(item) => {
      setQuery({ ...query, range: item.key })
    }} />
    <div>Offset: <input type="number" /></div>
  </div>
}
