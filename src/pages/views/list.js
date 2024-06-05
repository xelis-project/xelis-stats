import { Link } from 'react-router-dom'

import useSources from './sources'
import style from './style'

function DisplayList() {
  const sources = useSources()

  return <div className={style.list.container}>
    {sources.map((source) => {
      const { key, title, description } = source
      const link = `/views/${key}`
      return <Link key={key} to={link} className={style.list.item}>
        <div className={style.list.title}>{title}</div>
        <div className={style.list.description}>{description}</div>
      </Link>
    })}
  </div>
}

export default DisplayList