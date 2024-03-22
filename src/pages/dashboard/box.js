import { css } from 'goober'
import { Link } from 'react-router-dom'
import { scaleOnHover } from 'xelis-explorer/src/style/animate'
import { AreaChart, Area, Tooltip, ResponsiveContainer, XAxis, YAxis } from 'recharts'
import Icon from 'g45-react/components/fontawesome_icon'
import theme from 'xelis-explorer/src/style/theme'
import { useMemo } from 'react'
import useTheme from 'xelis-explorer/src/hooks/useTheme'
import { useLang } from 'g45-react/hooks/useLang'

export const style = {
  box: css`
    background-color: ${theme.apply({ xelis: `rgb(0 0 0 / 50%)`, dark: `rgb(0 0 0 / 50%)`, light: `rgb(255 255 255 / 50%)` })};
    border-radius: .5em;
    color: var(--text-color);
    min-width: 17em;
    max-width: 17em;
    min-height: 13em;
    max-height: 13em;
    position: relative;
    display: flex;
    flex-direction: column;

    > :nth-child(1) {
      font-size: .9em;
      opacity: .6;
      padding: 1em 1em .5em 1em;
    }
    
    > :nth-child(2) {
      font-weight: bold;
      font-size: 1.4em;
      padding: 0 1rem .5rem 1rem;

      > :nth-child(1) {
        font-weight: bold;
        font-size: .6em;
        margin-left: .3em;
        opacity: .4;
      }
    }

    > :nth-child(3) {
      flex: 1;
      overflow: hidden;

      &[data-loading="true"] {
        display: flex;
        align-items: center;
        justify-content: center;
        opacity: .5;
        margin-top: -2em;
      }
    }

    > :nth-child(4) {
      position: absolute;
      top: 1em;
      right: 1em;
      display: flex;
      gap: .6em;

      > * {
        cursor: pointer;
        opacity: .5;
        ${scaleOnHover({ scale: `.9` })}

        &:hover {
          opacity: 1;
        }
      }
    }

    > :nth-child(5) {
      position: absolute;
      padding: .5em .75em;
      font-size: .8em;
      bottom: 1em;
      left: 50%;
      transform: translateX(-50%);
      background-color: ${theme.apply({ xelis: ` rgb(0 0 0 / 50%)`, dark: ` rgb(0 0 0 / 50%)`, light: ` rgb(255 255 255 / 50%)` })};
      white-space: nowrap;
      border-radius: .5em;
    }

    svg {
      border-bottom-left-radius: .5em;
      border-bottom-right-radius: .5em;
    }

    table {
      width: 100%;
      
      th {
        padding: .5rem 1rem;
        font-weight: bold;
        text-align: left;
      }
      
      td {
        border-top: thin solid ${theme.apply({ xelis: `rgb(255 255 255 / 10%)`, dark: `rgb(255 255 255 / 10%)`, light: `rgb(0 0 0 / 10%)` })};
        padding: .5rem 1rem;
        font-size: .8em;
      }
    }
  `,
  tooltip: css`
    background-color: ${theme.apply({ xelis: `rgb(0 0 0 / 60%)`, dark: `rgb(0 0 0 / 60%)`, light: `rgb(255 255 255 / 60%)` })} !important;
    border: none !important;
    border-radius: 0.5em;
    padding: 0.5em !important;
  `
}

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

  return <ResponsiveContainer height="100%" width="100%">
    <AreaChart
      data={data}
      margin={{ top: 0, right: 0, left: 0, bottom: 0 }}
    >
      <Tooltip isAnimationActive={false} wrapperClassName={style.tooltip}
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
  let { headers = [], data = [], showHeader = true } = props

  const slicedData = useMemo(() => {
    const slicedData = []
    for (let i = 0; i < 3; i++) {
      const item = data[i]
      if (item) slicedData.push(item)
      else slicedData.push({})
    }
    return slicedData
  }, [data])

  return <table>
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
            return <td key={key}>{(value !== undefined && value !== null) ? value : `--`}</td>
          })}
        </tr>
      })}
    </tbody>
  </table>
}

function Box(props) {
  const { loading = false, noData = false, children, name, value, extra, info, bottomInfo, link } = props
  const { t } = useLang()

  return <div className={style.box}>
    <div>{name}</div>
    <div>{(loading || noData) ? `--` : <>{value}{extra && <span>{extra}</span>}</>}</div>
    <div data-loading={loading || noData}>
      {loading ? <Icon name="circle-notch" className="fa-spin" /> : <>
        {noData ? `NO DATA` : children}
      </>}
    </div>
    <div>
      {link && <Link to={link}><Icon name="expand" title={t(`Click to visualize more data.`)} /></Link>}
      {info && <Icon name="info-circle" title={info} />}
    </div>
    {bottomInfo && !loading && <div>{bottomInfo}</div>}
  </div>
}

export default Box