import { css } from 'goober'
import { scaleOnHover } from 'xelis-explorer/src/style/animate'
import theme from 'xelis-explorer/src/style/theme'
import { Link } from 'react-router-dom'

import useSources from './sources'

const style = {
  container: css`
    display: grid;
    gap: 1em;
    grid-template-columns: 1fr;
    margin-top: 2em;

    ${theme.query.minMobile} {
      grid-template-columns: 1fr 1fr;
    }

    > a {
      background: var(--bg-color);
      padding: 1em;
      border-radius: .5em;
      cursor: pointer;
      text-decoration: none;
      color: var(--text-color);
      ${scaleOnHover()}

      > :nth-child(1) {
        font-size: 1.2em;
        font-weight: bold;
        margin-bottom: .25em;
      }

      > :nth-child(2) {
        font-size: .9em;
        opacity: .6;
      }
    }
  `
}

function DisplayList() {
  const sources = useSources()

  return <div className={style.container}>
    {sources.map((source) => {
      const { key, title, description } = source
      const link = `/database?data_source=${key}`
      return <Link key={key} to={link}>
        <div>{title}</div>
        <div>{description}</div>
      </Link>
    })}
  </div>
}

export default DisplayList