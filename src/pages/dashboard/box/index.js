import { Link } from 'react-router-dom'
import { AreaChart, Area, Tooltip, ResponsiveContainer, XAxis, YAxis } from 'recharts'
import Icon from 'g45-react/components/fontawesome_icon'
import { useMemo } from 'react'
import useTheme from 'xelis-explorer/src/hooks/useTheme'
import { useLang } from 'g45-react/hooks/useLang'

import style from './style'

export function useChartStyle() {
  const { theme: currentTheme } = useTheme()

  const style = useMemo(() => {
    switch (currentTheme) {
      case `light`:
        return {
          stroke: `rgb(0 0 0)`,
          strokeOpacity: .5,
          fill: `rgb(0 0 0)`,
          fillOpacity: .2
        }
      case `dark`:
        return {
          stroke: `#3889ff`,
          strokeOpacity: 1,
          fill: `#1870cb`,
          fillOpacity: .2
        }
      case `xelis`:
        return {
          stroke: `rgb(93 227 179)`,
          strokeOpacity: 1,
          fill: `#287358`,
          fillOpacity: .5
        }
    }
  }, [currentTheme])

  return style
}

export function BoxAreaChart(props) {
  let { data = [], areaType = `monotone`, xDataKey = `x`, xFormat, yDataKey = `y`, yName, yFormat, yDomain = ['dataMin', 'dataMax'] } = props

  const chartStyle = useChartStyle()

  return <ResponsiveContainer
    height="100%" width="100%"
    className={style.chart.container}
  >
    <AreaChart
      data={data}
      margin={{ top: 0, right: 0, left: 0, bottom: 0 }}
    >
      <Tooltip isAnimationActive={false} wrapperClassName={style.chart.tooltip}
        labelFormatter={(v) => {
          if (typeof xFormat === `function`) return xFormat(v)
          return v
        }}
        formatter={(v) => {
          if (typeof yFormat === `function`) return [yFormat(v), yName]
          return [v, yName]
        }}
      />
      <XAxis hide dataKey={xDataKey} />
      <YAxis hide domain={yDomain} />
      <Area type={areaType} dataKey={yDataKey} isAnimationActive={false} strokeWidth={1} {...chartStyle} />
    </AreaChart>
  </ResponsiveContainer>
}

export function BoxTable(props) {
  let { headers = [], data = [], showHeader = true, maxRow = 3 } = props

  const slicedData = useMemo(() => {
    if (!maxRow) return data

    const slicedData = []
    for (let i = 0; i < maxRow; i++) {
      const item = data[i]
      if (item) slicedData.push(item)
      else slicedData.push({})
    }
    return slicedData
  }, [data])

  return <table className={style.table}>
    {showHeader && <thead>
      <tr>
        {headers.map(header => {
          const { key, title } = header
          return <th key={key}>{title}</th>
        })}
      </tr>
    </thead>}
    <tbody>
      {slicedData.map((row, rowIndex) => {
        return <tr key={rowIndex}>
          {headers.map((header) => {
            const { key, render } = header
            let value = row[key]
            if (typeof render === `function`) value = render(value, row)
            return <td key={key}>{value != null ? value : `--`}</td>
          })}
        </tr>
      })}
    </tbody>
  </table>
}

function Box(props) {
  const { loading = false, noData = false, children, name, value, extra, info, bottomInfo, link } = props
  const { t } = useLang()

  return <div className={style.container}>
    <div className={style.title}>{name}</div>
    {value != null && <div className={style.subtitle.container}>
      {(loading || noData) ? `--` : <>{value}{extra && <span className={style.subtitle.extra}>{extra}</span>}</>}
    </div>}
    <div className={style.content}>
      {loading && <div className={style.loading}>
        <Icon name="circle-notch" className="fa-spin" />
      </div>}
      {(noData && !loading) && <div className={style.loading}>
        NO DATA
      </div>}
      {(!noData && !loading) && children}
    </div>
    <div className={style.topRightIcon}>
      {link && <Link to={link}><Icon name="arrow-up-right-from-square" title={t(`Click to visualize more data.`)} /></Link>}
      {info && <Icon name="info-circle" title={info} />}
    </div>
    {bottomInfo && !loading && <div className={style.bottomInfo}>
      {bottomInfo}
    </div>}
  </div>
}

export default Box